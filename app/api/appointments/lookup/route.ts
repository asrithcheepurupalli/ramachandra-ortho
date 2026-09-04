// Public, phone-scoped lookup for patient self-service — no login exists on
// the patient side, so a phone number match is the trust boundary, same as
// the booking flow and the WhatsApp bot.
import { NextResponse, type NextRequest } from "next/server";
import { dbActiveAppointmentsByPhone } from "@/lib/db";
import { otpEnabled } from "@/lib/otp";

const RATE_LIMIT = 8;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const recentHits = new Map<string, number[]>();
function isRateLimited(key: string): boolean {
  const now = Date.now();
  const hits = (recentHits.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  hits.push(now);
  recentHits.set(key, hits);
  return hits.length > RATE_LIMIT;
}

export async function POST(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (isRateLimited(ip)) return NextResponse.json({ error: "Too many requests. Please try again in a bit." }, { status: 429 });

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  const { phone } = body ?? {};
  if (typeof phone !== "string" || !phone.trim()) return NextResponse.json({ error: "phone is required" }, { status: 400 });

  try {
    const appointments = await dbActiveAppointmentsByPhone(phone.trim());
    // otpEnabled tells the client whether cancel/reschedule/pay are gated on a
    // SIM proof, so it only shows the verify panel when the gate is actually
    // on (the OTP template exists in Meta) rather than dead UI on 503.
    return NextResponse.json({ appointments, otpEnabled: otpEnabled() });
  } catch (err) {
    console.error("/api/appointments/lookup", err);
    return NextResponse.json({ error: "Could not look up appointments" }, { status: 500 });
  }
}
