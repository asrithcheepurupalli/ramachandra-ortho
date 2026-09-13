// Public, phone-scoped lookup for patient self-service — no login exists on
// the patient side, so a phone number match is the trust boundary, same as
// the booking flow and the WhatsApp bot.
import { NextResponse, type NextRequest } from "next/server";
import { dbActiveAppointmentsByPhone } from "@/lib/db";
import { otpEnabled } from "@/lib/otp";
import { reportError } from "@/lib/bugdesk";
import { isRateLimited } from "@/lib/rate-limit";

const RATE_LIMIT = 8;
const RATE_WINDOW_MS = 10 * 60 * 1000;

export async function POST(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (await isRateLimited(`lookup:${ip}`, RATE_LIMIT, RATE_WINDOW_MS)) {
    return NextResponse.json({ error: "Too many requests. Please try again in a bit." }, { status: 429 });
  }

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  const { phone, includePending } = body ?? {};
  if (typeof phone !== "string" || !phone.trim()) return NextResponse.json({ error: "phone is required" }, { status: 400 });

  try {
    const appointments = await dbActiveAppointmentsByPhone(phone.trim(), Boolean(includePending));
    // otpEnabled tells the client whether cancel/reschedule/pay are gated on a
    // SIM proof, so it only shows the verify panel when the gate is actually
    // on (the OTP template exists in Meta) rather than dead UI on 503.
    return NextResponse.json({ appointments, otpEnabled: otpEnabled() });
  } catch (err) {
    console.error("/api/appointments/lookup", err);
    await reportError("appointments/lookup", err, { severity: "warning" });
    return NextResponse.json({ error: "Could not look up appointments" }, { status: 500 });
  }
}
