// Meta WhatsApp Cloud API webhook — GET handles the one-time verification
// handshake, POST receives inbound patient messages and drives the bot.
// Always acks POST with 200 quickly; Meta retries (and can disable) a webhook
// that errors or is slow, so failures are logged, never surfaced as a non-200.
import { NextResponse, type NextRequest } from "next/server";
import { dbAddBooking, dbTakenSlots, dbSetStatus, dbLoadSchedule, dbLoadWaSession, dbSaveWaSession, dbActiveAppointmentsByPhone, dbGetOrCreatePaymentLink } from "@/lib/db";
import { botReplyServer, type Backend, type ServerBotState } from "@/lib/bot";
import { sendText, sendButtons, sendList, sendBookingConfirmation, verifySignature, safeEqual } from "@/lib/meta-whatsapp";
import { SlotTakenError } from "@/lib/errors";

const backend: Backend = {
  addBooking: dbAddBooking,
  takenSlots: dbTakenSlots,
  setStatus: dbSetStatus,
  activeAppointmentsByPhone: dbActiveAppointmentsByPhone,
  createPaymentLink: dbGetOrCreatePaymentLink,
};

// Remembers the numbered chip list from the last reply, so a patient can type
// "2" instead of the exact slot label — matched back to the same label text
// botReplyServer expects (it only knows plain-text label matching).
type WaState = ServerBotState & { lastChips?: string[] };

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
        await sendText(
          from,
          err instanceof SlotTakenError
            ? "Sorry, that slot was just taken. Please message us again to pick another time."
            : "Something went wrong booking that. Please message us and we'll sort it out."
        );
      }
      await dbSaveWaSession(from, lang, state, wamid);
      return new NextResponse("OK", { status: 200 });
    }

    const text: string | undefined =
      message.text?.body ?? message.interactive?.button_reply?.title ?? message.interactive?.list_reply?.title;
    if (!text) return new NextResponse("OK", { status: 200 });

    const waState = state as WaState;

    const asChipNumber = /^\s*(\d+)\s*$/.exec(text);
    const effectiveInput =
      asChipNumber && waState.lastChips?.[Number(asChipNumber[1]) - 1]
        ? waState.lastChips[Number(asChipNumber[1]) - 1]
        : text;

    const sched = await dbLoadSchedule();
    const result = await botReplyServer(effectiveInput, lang, waState, from, backend, sched, "whatsapp");

    const newState: WaState = { ...result.state, lastChips: result.chips };
    await dbSaveWaSession(from, lang, newState, wamid);

    // Tappable UI instead of a numbered wall of text where Meta's limits allow
    // it (3 buttons, or a 10-row list); only an overflow set (>10, shouldn't
    // happen post-window-split but a custom exception window could still do
    // it) falls back to the old numbered-text list.
    const { chips } = result;
    const body = result.reply.join("\n\n");
    if (!chips.length) {
      await sendText(from, body);
    } else if (chips.length <= 3 && chips.every((c) => c.length <= 20)) {
      await sendButtons(from, body, chips);
    } else if (chips.length <= 10) {
      await sendList(from, body, "Choose", chips);
    } else {
      await sendText(from, body + "\n\n" + chips.map((c, i) => `${i + 1}. ${c}`).join("\n"));
    }

    return new NextResponse("OK", { status: 200 });
  } catch (err) {
    console.error("/api/whatsapp", err);
    return new NextResponse("OK", { status: 200 });
  }
}
