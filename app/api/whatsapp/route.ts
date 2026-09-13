// Meta WhatsApp Cloud API webhook — GET handles the one-time verification
// handshake, POST receives inbound patient messages and drives the bot.
// Always acks POST with 200 quickly; Meta retries (and can disable) a webhook
// that errors or is slow, so failures are logged, never surfaced as a non-200.
import { NextResponse, type NextRequest } from "next/server";
import { dbAddBooking, dbLoadSchedule, dbLoadWaSession, dbSaveWaSession, dbActiveAppointmentsByPhone, dbGetOrCreatePaymentLink, dbReactivateExpiredHold, dbRescheduleAppointment } from "@/lib/db";
import { botReplyServer, botStartServer, langPickPrompt, matchLangChoice, detectLangSwitch, flowSlotTakenMsg, flowBookFailMsg, flowPendingHoldMsg, flowDuplicateSlotMsg, flowPayPrompt, flowPayNowLabel, flowStartOverLabel, flowReturningConfirmMsg, flowFreeConfirmMsg, type Backend, type ServerBotState } from "@/lib/bot";
import { sendText, sendButtons, sendList, sendBookingConfirmation, verifySignature, safeEqual } from "@/lib/meta-whatsapp";
import { sendRescheduledEmail, sendNewAppointmentEmail } from "@/lib/mailer";
import { SlotTakenError, PendingHoldError, DuplicateSlotError } from "@/lib/errors";
import { report, reportError } from "@/lib/bugdesk";

const backend: Backend = {
  addBooking: dbAddBooking,
  activeAppointmentsByPhone: dbActiveAppointmentsByPhone,
  createPaymentLink: dbGetOrCreatePaymentLink,
  reactivateExpiredHold: dbReactivateExpiredHold,
  // Move the booking AND re-confirm it over WhatsApp, matching what the site's
  // reschedule route does ("your appointment is confirmed for X" reads fine for
  // a moved booking too).
  reschedule: async (id, date, time) => {
    const appt = await dbRescheduleAppointment(id, date, time);
    const whatsappOk = await sendBookingConfirmation(appt);
    if (!whatsappOk) await reportError("whatsapp", new Error("reschedule WhatsApp notify failed"), { severity: "warning", info: { channel: "whatsapp", appt: appt.id } });
    const emailOk = await sendRescheduledEmail(appt);
    if (!emailOk) await reportError("whatsapp", new Error("reschedule email notify failed"), { severity: "warning", info: { channel: "email", appt: appt.id } });
    return appt;
  },
  // Claim bookings (returning_unverified / review_free) skip Razorpay, so
  // there's no webhook to fire
  // the staff notification the way a paid booking gets it — send it here
  // instead, right after the claim booking is created.
  notifyClaimBooking: async (appt) => {
    const ok = await sendNewAppointmentEmail(appt);
    if (!ok) await reportError("whatsapp", new Error("claim email notify failed"), { severity: "warning", info: { channel: "email", appt: appt.id } });
  },
};

// Remembers the numbered chip list from the last reply, so a patient can type
// "2" instead of the exact slot label — matched back to the same label text
// botReplyServer expects (it only knows plain-text label matching).
type WaState = ServerBotState & { lastChips?: string[] };

// Tappable UI instead of a numbered wall of text where Meta's limits allow it
// (3 buttons, or a 10-row list); only an overflow set (>10, shouldn't happen
// post-window-split but a custom exception window could still do it) falls
// back to the old numbered-text list.
async function sendReply(to: string, body: string, chips: string[]) {
  if (!chips.length) {
    await sendText(to, body);
  } else if (chips.length <= 3 && chips.every((c) => c.length <= 20)) {
    await sendButtons(to, body, chips);
  } else if (chips.length <= 10) {
    await sendList(to, body, "Choose", chips);
  } else {
    await sendText(to, body + "\n\n" + chips.map((c, i) => `${i + 1}. ${c}`).join("\n"));
  }
}

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const mode = params.get("hub.mode");
  const token = params.get("hub.verify_token");
  const challenge = params.get("hub.challenge");

  const verifyToken = process.env.META_VERIFY_TOKEN;
  if (mode === "subscribe" && challenge && verifyToken && safeEqual(token ?? "", verifyToken)) {
    return new NextResponse(challenge, { status: 200 });
  }
  return new NextResponse("Forbidden", { status: 403 });
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text();

  if (!verifySignature(rawBody, req.headers.get("x-hub-signature-256"))) {
    console.error("WhatsApp webhook: bad signature");
    // Auth itself is failing, not a single message — escalate immediately.
    await report({ source: "whatsapp", message: "WhatsApp webhook delivered a bad signature", severity: "critical" });
    return new NextResponse("OK", { status: 200 });
  }

  try {
    const payload = JSON.parse(rawBody);
    const value = payload?.entry?.[0]?.changes?.[0]?.value;
    // Delivery/read/failed callbacks arrive on the same messages webhook field.
    // Log them so a template Meta accepts but silently drops (authentication
    // messages in particular) still leaves a verdict in the Vercel logs —
    // "delivered", or a failed status carrying Meta's error code.
    for (const st of value?.statuses ?? []) {
      console.log(
        "WhatsApp status",
        st.id ?? "",
        st.status ?? "",
        Array.isArray(st.errors) ? JSON.stringify(st.errors) : ""
      );
    }
    const message = value?.messages?.[0];
    if (!message) return new NextResponse("OK", { status: 200 }); // status/read receipts, no-op

    const from: string = message.from;
    const wamid: string | undefined = message.id;
    if (!from) return new NextResponse("OK", { status: 200 });

    // Meta retries a webhook delivery that times out or errors — same message
    // id redelivered. Without this a slow response (or the 500 branch below)
    // can double-process the same inbound message, e.g. a duplicate booking
    // from a single Flow submission.
    const [{ lang, state, lastWamid }, sched] = await Promise.all([
      dbLoadWaSession(from),
      dbLoadSchedule(),
    ]);
    if (wamid && wamid === lastWamid) return new NextResponse("OK", { status: 200 });

    // Submission from the live "Appointment" WhatsApp Flow (see
    // app/api/whatsapp/flow/route.ts for the screen data behind it). It arrives
    // as a structured reply, not plain text,
    // so it's handled before the text/button/list extraction below.
    if (message.interactive?.type === "nfm_reply") {
      try {
        const parsed = JSON.parse(message.interactive.nfm_reply.response_json);
        // The flow's "Patient type" choice decides how the booking confirms:
        // "new" books as a regular hold that pays online (mandatory pay prompt
        // below); "returning" and "review" are claim bookings that skip payment
        // entirely and confirm straight away. The admin queue flags returning
        // rows so the desk collects the fee at the counter.
        const flowClaim: "returning_unverified" | "review_free" | undefined =
          parsed.patient_type === "returning" ? "returning_unverified"
          : parsed.patient_type === "review" ? "review_free"
          : undefined;
        const appt = await dbAddBooking({
          name: parsed.name,
          phone: parsed.phone || from,
          age: typeof parsed.age === "number" ? parsed.age : 0,
          // The flow's gender dropdown submits "M" or "F"; the conversational
          // bot path doesn't ask, so anything else stays null.
          gender: parsed.gender === "M" || parsed.gender === "F" ? parsed.gender : null,
          date: parsed.date,
          time: parsed.time,
          source: "whatsapp",
          claim: flowClaim,
        });
        if (flowClaim) {
          // Claim flow submissions land confirmed (reserved) with no Razorpay
          // step, and no webhook ever fires for them — notify the desk directly
          // and confirm to the patient in place of the pay prompt. Returning
          // still carries the "pay at the clinic" note.
          await backend.notifyClaimBooking(appt);
          const d = new Date(appt.date + "T00:00:00");
          const [hh, mm] = appt.time.split(":").map(Number);
          const ampm = hh >= 12 ? "PM" : "AM";
          const slotLabel = `${d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" })} at ${hh % 12 || 12}:${String(mm).padStart(2, "0")} ${ampm}`;
          try {
            await sendText(from, flowClaim === "returning_unverified" ? flowReturningConfirmMsg(lang, appt.token, slotLabel, appt.fee) : flowFreeConfirmMsg(lang, appt.token, slotLabel));
          } catch (err) { console.error("whatsapp flow: claim confirm failed", err); await reportError("whatsapp", err, { severity: "warning", info: { stage: "nfm_reply_claim_confirm", from } }); }
        } else {
          // No confirmation template until payment lands. The slot is held 15
          // minutes as payment_pending, so all we send now is the mandatory pay
          // prompt with a REAL Pay now button (same interactive-reply path the
          // conversational bot chips use), letting the patient tap rather than
          // type. The real "appointment confirmed" template (META_TEMPLATE_PAID)
          // fires from the Razorpay webhook once payment completes.
          try { await sendButtons(from, flowPayPrompt(lang), [flowPayNowLabel(lang)]); } catch (err) { console.error("whatsapp flow: pay prompt failed", err); await reportError("whatsapp", err, { severity: "critical", info: { stage: "nfm_reply_pay_prompt", from } }); }
        }
      } catch (err) {
        // Held-slot / unpaid-hold / duplicate-slot conditions are business
        // states, not bugs — patients get their message, the desk hears nothing.
        if (err instanceof PendingHoldError || err instanceof SlotTakenError || err instanceof DuplicateSlotError) {
          try {
            if (err instanceof PendingHoldError) await sendButtons(from, flowPendingHoldMsg(lang), [flowPayNowLabel(lang), flowStartOverLabel(lang)]);
            else if (err instanceof DuplicateSlotError) await sendText(from, flowDuplicateSlotMsg(lang));
            else await sendText(from, flowSlotTakenMsg(lang));
          } catch (err2) { console.error("whatsapp flow: error reply failed", err2); await reportError("whatsapp", err2, { severity: "warning", info: { stage: "nfm_reply_business", from } }); }
          // Anything else genuinely failed the booking — surface it.
        } else {
          await reportError("whatsapp", err, { severity: "critical", info: { stage: "nfm_reply_book", from } });
          try { await sendText(from, flowBookFailMsg(lang)); } catch (err2) { console.error("whatsapp flow: error reply failed", err2); await reportError("whatsapp", err2, { severity: "warning", info: { stage: "nfm_reply_book", from } }); }
        }
      }
      // Reset the conversation to idle: if the patient had a chat booking in
      // progress (say, typing a name) when they submitted the Flow, the stage
      // must not survive — their next tap ("Pay now" included) would otherwise
      // be consumed as text in the abandoned flow. lastChips carries the real
      // Pay now button so a numeric "1" reply still resolves to it.
      const flowState: WaState = { stage: "idle", lastChips: [flowPayNowLabel(lang)] };
      await dbSaveWaSession(from, lang, flowState, wamid);
      return new NextResponse("OK", { status: 200 });
    }

    // Inbound text from the three shapes a patient can send: a typed message
    // (text), a quick-reply button tapped on a template (button — the label
    // text, e.g. "Cancel appointment" on META_TEMPLATE_CONFIRM_V2), or a reply
    // button / list item tapped on one of our interactive messages. All three
    // reach intent detection by their label text below.
    const text: string | undefined =
      message.text?.body ?? message.button?.text ?? message.interactive?.button_reply?.title ?? message.interactive?.list_reply?.title;
    if (!text) return new NextResponse("OK", { status: 200 });

    const waState = state as WaState;

    // One-time language gate for a phone the bot has never talked to (or that
    // never finished picking). First turn here has no lastChips yet — that's
    // the signal to send the picker instead of treating the message as an
    // intent; the reply turn resolves it against those chips like any other.
    if (waState.stage === "await_lang") {
      const asChoiceNumber = /^\s*(\d+)\s*$/.exec(text);
      const choiceText =
        waState.lastChips?.length && asChoiceNumber && waState.lastChips[Number(asChoiceNumber[1]) - 1]
          ? waState.lastChips[Number(asChoiceNumber[1]) - 1]
          : text;
      const picked = waState.lastChips?.length ? matchLangChoice(choiceText) : null;

      if (picked) {
        const start = botStartServer(picked);
        const newState: WaState = { ...start.state, lastChips: start.chips };
        await dbSaveWaSession(from, picked, newState, wamid);
        await sendReply(from, start.reply.join("\n\n"), start.chips);
      } else {
        const prompt = langPickPrompt();
        const newState: WaState = { stage: "await_lang", lastChips: prompt.chips };
        await dbSaveWaSession(from, lang, newState, wamid);
        await sendReply(from, prompt.reply.join("\n\n"), prompt.chips);
      }
      return new NextResponse("OK", { status: 200 });
    }

    // Same switch, for a phone that already picked a language at some point —
    // works at any stage, not just idle, since a patient can ask for this
    // mid-flow; matches the existing "cancel" escape hatch in dropping
    // whatever was in progress rather than trying to preserve it.
    const langSwitch = detectLangSwitch(text);
    if (langSwitch === "ask") {
      const prompt = langPickPrompt();
      const newState: WaState = { stage: "await_lang", lastChips: prompt.chips };
      await dbSaveWaSession(from, lang, newState, wamid);
      await sendReply(from, prompt.reply.join("\n\n"), prompt.chips);
      return new NextResponse("OK", { status: 200 });
    }
    if (langSwitch && langSwitch !== lang) {
      const start = botStartServer(langSwitch);
      const newState: WaState = { ...start.state, lastChips: start.chips };
      await dbSaveWaSession(from, langSwitch, newState, wamid);
      await sendReply(from, start.reply.join("\n\n"), start.chips);
      return new NextResponse("OK", { status: 200 });
    }

    const asChipNumber = /^\s*(\d+)\s*$/.exec(text);
    const effectiveInput =
      asChipNumber && waState.lastChips?.[Number(asChipNumber[1]) - 1]
        ? waState.lastChips[Number(asChipNumber[1]) - 1]
        : text;

    const result = await botReplyServer(effectiveInput, lang, waState, from, backend, sched, "whatsapp");

    const newState: WaState = { ...result.state, lastChips: result.chips };
    await dbSaveWaSession(from, lang, newState, wamid);

    // The session (and this wamid as processed) is already saved above, so a
    // send failure here can't be recovered by a Meta retry — a retried
    // delivery of the same message would just be skipped as a duplicate (see
    // the lastWamid check above). A booking that already committed inside
    // botReplyServer (dbAddBooking) would then have gone through with the
    // patient never told, and no other channel exists to tell them. That's
    // silent by default, so log loudly with enough to manually follow up on
    // rather than letting it disappear into the generic catch below.
    try {
      await sendReply(from, result.reply.join("\n\n"), result.chips);
    } catch (err) {
      console.error("whatsapp: reply send failed after state committed — patient may be un-notified", JSON.stringify({ from, stage: newState.stage }), err);
      await reportError("whatsapp", err, { severity: "critical", info: { stage: "post_commit_reply", from } });
    }

    return new NextResponse("OK", { status: 200 });
  } catch (err) {
    console.error("/api/whatsapp", err);
    // Business errors surface to the patient inside the handler — only reach
    // the desk when the webhook itself genuinely failed.
    if (!(err instanceof SlotTakenError) && !(err instanceof PendingHoldError) && !(err instanceof DuplicateSlotError)) {
      await reportError("whatsapp", err, { severity: "critical" });
    }
    return new NextResponse("OK", { status: 200 });
  }
}
