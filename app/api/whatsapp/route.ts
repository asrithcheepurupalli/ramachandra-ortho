// Meta WhatsApp Cloud API webhook — GET handles the one-time verification
// handshake, POST receives inbound patient messages and drives the bot.
// Always acks POST with 200 quickly; Meta retries (and can disable) a webhook
// that errors or is slow, so failures are logged, never surfaced as a non-200.
import { NextResponse, type NextRequest } from "next/server";
import { dbAddBooking, dbTakenSlots, dbSetStatus, dbLoadSchedule, dbLoadWaSession, dbSaveWaSession } from "@/lib/db";
import { botReplyServer, type Backend, type ServerBotState } from "@/lib/bot";
import { sendText, sendBookingConfirmation, verifySignature } from "@/lib/meta-whatsapp";
import { SlotTakenError } from "@/lib/errors";

const backend: Backend = { addBooking: dbAddBooking, takenSlots: dbTakenSlots, setStatus: dbSetStatus };

// Remembers the numbered chip list from the last reply, so a patient can type
// "2" instead of the exact slot label — matched back to the same label text
// botReplyServer expects (it only knows plain-text label matching).
type WaState = ServerBotState & { lastChips?: string[] };

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const mode = params.get("hub.mode");
  const token = params.get("hub.verify_token");
  const challenge = params.get("hub.challenge");

  if (mode === "subscribe" && token === process.env.META_VERIFY_TOKEN && challenge) {
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
    const message = payload?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return new NextResponse("OK", { status: 200 }); // status/read receipts, no-op

    const from: string = message.from;

    // Submission of the "Appointment" WhatsApp Flow (manually sent from
    // WhatsApp Manager — see app/api/whatsapp/flow/route.ts for the live
    // screen data behind it). Arrives as a structured reply, not plain text,
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
      return new NextResponse("OK", { status: 200 });
    }

    const text: string | undefined =
      message.text?.body ?? message.interactive?.button_reply?.title ?? message.interactive?.list_reply?.title;
    if (!from || !text) return new NextResponse("OK", { status: 200 });

    const { lang, state } = await dbLoadWaSession(from);
    const waState = state as WaState;

    const asChipNumber = /^\s*(\d+)\s*$/.exec(text);
    const effectiveInput =
      asChipNumber && waState.lastChips?.[Number(asChipNumber[1]) - 1]
        ? waState.lastChips[Number(asChipNumber[1]) - 1]
        : text;

    const sched = await dbLoadSchedule();
    const result = await botReplyServer(effectiveInput, lang, waState, from, backend, sched, "whatsapp");

    const newState: WaState = { ...result.state, lastChips: result.chips };
    await dbSaveWaSession(from, lang, newState);

    const chipList = result.chips.length
      ? "\n\n" + result.chips.map((c, i) => `${i + 1}. ${c}`).join("\n")
      : "";
    await sendText(from, result.reply.join("\n\n") + chipList);

    return new NextResponse("OK", { status: 200 });
  } catch (err) {
    console.error("/api/whatsapp", err);
    return new NextResponse("OK", { status: 200 });
  }
}
