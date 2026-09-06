// Meta WhatsApp Cloud API webhook — GET handles the one-time verification
// handshake, POST receives inbound patient messages and drives the bot.
// Always acks POST with 200 quickly; Meta retries (and can disable) a webhook
// that errors or is slow, so failures are logged, never surfaced as a non-200.
import { NextResponse, type NextRequest } from "next/server";
import { dbAddBooking, dbTakenSlots, dbSetStatus, dbLoadSchedule, dbLoadWaSession, dbSaveWaSession, dbActiveAppointmentsByPhone, dbGetOrCreatePaymentLink, dbRescheduleAppointment } from "@/lib/db";
import { cancelAppointmentWithRefund } from "@/lib/refunds";
import { botReplyServer, botStartServer, langPickPrompt, matchLangChoice, detectLangSwitch, flowSlotTakenMsg, flowBookFailMsg, type Backend, type ServerBotState } from "@/lib/bot";
import { sendText, sendButtons, sendList, sendBookingConfirmation, verifySignature, safeEqual } from "@/lib/meta-whatsapp";
import { SlotTakenError } from "@/lib/errors";

const backend: Backend = {
  addBooking: dbAddBooking,
  takenSlots: dbTakenSlots,
  setStatus: dbSetStatus,
  cancelWithRefund: cancelAppointmentWithRefund,
  activeAppointmentsByPhone: dbActiveAppointmentsByPhone,
  createPaymentLink: dbGetOrCreatePaymentLink,
  // Move the booking AND re-confirm it over WhatsApp, matching what the site's
  // reschedule route does ("your appointment is confirmed for X" reads fine for
  // a moved booking too).
  reschedule: async (id, date, time) => {
    const appt = await dbRescheduleAppointment(id, date, time);
    try { await sendBookingConfirmation(appt); } catch (err) { console.error("whatsapp reschedule: notify failed", err); }
    return appt;
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
    const { lang, state, lastWamid } = await dbLoadWaSession(from);
    if (wamid && wamid === lastWamid) return new NextResponse("OK", { status: 200 });

    // Submission from the live "Appointment" WhatsApp Flow (see
    // app/api/whatsapp/flow/route.ts for the screen data behind it). It arrives
    // as a structured reply, not plain text,
    // so it's handled before the text/button/list extraction below.
    if (message.interactive?.type === "nfm_reply") {
      const parsed = JSON.parse(message.interactive.nfm_reply.response_json);
      try {
        const appt = await dbAddBooking({
          name: parsed.name,
          phone: parsed.phone || from,
          reason: parsed.reason,
          date: parsed.date,
          time: parsed.time,
          source: "whatsapp",
        });
        await sendBookingConfirmation(appt);
      } catch (err) {
        await sendText(from, err instanceof SlotTakenError ? flowSlotTakenMsg(lang) : flowBookFailMsg(lang));
      }
      await dbSaveWaSession(from, lang, state, wamid);
      return new NextResponse("OK", { status: 200 });
    }

    const text: string | undefined =
      message.text?.body ?? message.interactive?.button_reply?.title ?? message.interactive?.list_reply?.title;
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

    const sched = await dbLoadSchedule();
    const result = await botReplyServer(effectiveInput, lang, waState, from, backend, sched, "whatsapp");

    const newState: WaState = { ...result.state, lastChips: result.chips };
    await dbSaveWaSession(from, lang, newState, wamid);

    await sendReply(from, result.reply.join("\n\n"), result.chips);

    return new NextResponse("OK", { status: 200 });
  } catch (err) {
    console.error("/api/whatsapp", err);
    return new NextResponse("OK", { status: 200 });
  }
}
