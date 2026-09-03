// WhatsApp Flow encrypted data-exchange endpoint. Meta calls this directly
// (not through the webhook route) whenever the "Appointment" Flow needs live
// screen data — every request/response is RSA+AES encrypted per Meta's Flow
// endpoint spec (see lib/whatsapp-flow-crypto.ts). The live automation
// triggers this Flow as part of the WhatsApp appointment journey; the
// plain-text bot in lib/bot.ts shares none of this code path.
//
// Response codes follow Meta's spec exactly, since the WhatsApp client
// branches on them: 432 tells it the signature didn't match, 421 tells it
// the public key is stale and to re-fetch it, 200 is a normal (encrypted)
// reply.
import { createHmac } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { verifySignature } from "@/lib/meta-whatsapp";
import { decryptFlowRequest, encryptFlowResponse } from "@/lib/whatsapp-flow-crypto";
import { dbTakenSlots, dbLoadSchedule } from "@/lib/db";
import { slotsFor, ymd, fmt, nowIST, type SchedState } from "@/lib/schedule";
import { serviceGroups } from "@/lib/services";

const DAYS_AHEAD = 14;

const reasonOptions = serviceGroups.flatMap((g) => g.items.map((s) => ({ id: s.name, title: s.name })));

async function liveOpenDates(sched: SchedState): Promise<{ id: string; title: string }[]> {
  const out: { id: string; title: string }[] = [];
  const now = nowIST();
  for (let i = 0; i < DAYS_AHEAD; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() + i);
    const date = ymd(d);
    const taken = await dbTakenSlots(date);
    if (slotsFor(d, taken, sched).length > 0) {
      out.push({ id: date, title: d.toLocaleDateString("en-IN", { weekday: "short", month: "short", day: "2-digit" }) });
    }
  }
  return out;
}

function liveTimeSlots(date: string, taken: string[], sched: SchedState) {
  return slotsFor(new Date(`${date}T00:00:00`), taken, sched).map((t) => ({ id: t, title: fmt(t) }));
}

function encryptedReply(payload: object, aesKey: Buffer, iv: Buffer) {
  return new NextResponse(encryptFlowResponse(payload, aesKey, iv), {
    status: 200,
    headers: { "Content-Type": "text/plain" },
  });
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text();

  if (!verifySignature(rawBody, req.headers.get("x-hub-signature-256"))) {
    const header = req.headers.get("x-hub-signature-256");
    const secret = process.env.META_APP_SECRET;
    console.error("WhatsApp Flow endpoint: bad signature", {
      hasSecret: !!secret,
      hasHeader: !!header,
      headerLen: header?.length ?? 0,
      bodyLen: rawBody.length,
      contentType: req.headers.get("content-type"),
      // Non-reversible HMAC digests only — safe to log, cannot be used to recover the secret.
      provided: header?.replace(/^sha256=/, ""),
      expected: secret ? createHmac("sha256", secret).update(rawBody).digest("hex") : null,
    });
    return new NextResponse("Signature verification failed", { status: 432 });
  }

  let decrypted: ReturnType<typeof decryptFlowRequest>;
  try {
    decrypted = decryptFlowRequest(JSON.parse(rawBody));
  } catch (err) {
    console.error("WhatsApp Flow endpoint: decrypt failed", err);
    return new NextResponse("Decryption failed", { status: 421 });
  }
  const { payload, aesKey, iv } = decrypted;

  try {
    const { action, screen, data } = payload as { action: string; screen?: string; data?: Record<string, any> };

    if (data?.error) {
      console.error("WhatsApp Flow client error notification", data);
      return encryptedReply({ data: { acknowledged: true } }, aesKey, iv);
    }

    if (action === "ping") {
      return encryptedReply({ data: { status: "active" } }, aesKey, iv);
    }

    if (action === "INIT") {
      const sched = await dbLoadSchedule();
      return encryptedReply(
        {
          screen: "APPOINTMENT",
          data: { reason: reasonOptions, date: await liveOpenDates(sched), time: [], time_enabled: false },
        },
        aesKey,
        iv
      );
    }

    if (action === "data_exchange" && screen === "APPOINTMENT") {
      const sched = await dbLoadSchedule();
      const date: string | undefined = data?.date;
      const dateOptions = await liveOpenDates(sched);
      const time = date ? liveTimeSlots(date, await dbTakenSlots(date), sched) : [];

      if (date && time.length === 0) {
        return encryptedReply(
          {
            screen: "APPOINTMENT",
            data: { reason: reasonOptions, date: dateOptions, time: [], time_enabled: false },
            error_message: "No slots left that day — please pick another date.",
          },
          aesKey,
          iv
        );
      }
      return encryptedReply(
        { screen: "APPOINTMENT", data: { reason: reasonOptions, date: dateOptions, time, time_enabled: time.length > 0 } },
        aesKey,
        iv
      );
    }

    console.error("WhatsApp Flow endpoint: unhandled action", action, screen);
    return encryptedReply({ data: { acknowledged: true } }, aesKey, iv);
  } catch (err) {
    console.error("/api/whatsapp/flow", err);
    return new NextResponse("Internal error", { status: 500 });
  }
}
