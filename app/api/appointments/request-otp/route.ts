// Public: send a one-time verification code to a phone, as WhatsApp template
// ortho_verification_code. Callable by anyone, but only meaningful for a
// number with an active appointment — the code is the ownership proof the
// self-service mutation routes (cancel / reschedule / pay) now require, so a
// stranger who merely knows a patient's phone number can no longer touch
// their booking.
//
// ── Template contract ────────────────────────────────────────────────────────
//   Name:     ortho_verification_codev1
//   Category: AUTHENTICATION (one-time passcode), NOT Utility — Meta rejects
//             OTP-flavored copy ("verification code / do not share / expires")
//             in Utility templates. The Authentication category ships a
//             Meta-fixed, uneditable body plus a "Copy code" button.
//   Language: English (IND) = en_IN; META_TEMPLATE_LANG_OTP must match.
//   Body:     "{{1}} is your verification code. For your security, do not share
//             this code." + "Expires in 10 minutes".
//   Send:     The code goes into the {{1}} body slot AND the "Copy code" URL
//             button param (sendVerificationCode in lib/meta-whatsapp.ts) —
//             without the button param Meta rejects the send with (#131008).
// ────────────────────────────────────────────────────────────────────────────
import { NextResponse, type NextRequest } from "next/server";
import { dbActiveAppointmentsByPhone } from "@/lib/db";
import { requestOtp, otpEnabled } from "@/lib/otp";
import { sendVerificationCode } from "@/lib/meta-whatsapp";

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

  // The whole OTP path only exists once the verification template is set in
  // Meta (see otpEnabled in lib/otp.ts). Until then there is nothing to send
  // and — since the mutation routes don't enforce the gate either — no reason
  // to. Report it clearly rather than 502-ing meaninglessly.
  if (!otpEnabled()) return NextResponse.json({ error: "Verification isn't set up yet" }, { status: 503 });

  // Only send to numbers that actually own a booking — identical trust rule to
  // the lookup route; keeps this from being a free SMS/template-spam endpoint.
  try {
    const owned = await dbActiveAppointmentsByPhone(phone.trim());
    if (!owned.length) return NextResponse.json({ error: "Appointment not found" }, { status: 404 });

    const code = await requestOtp(phone.trim());
    if (!code) return NextResponse.json({ error: "A code was recently sent. Please try again in a few minutes." }, { status: 429 });

    const sent = await sendVerificationCode(phone.trim(), code);
    if (!sent) return NextResponse.json({ error: "Couldn't send the code right now. Please try again." }, { status: 502 });
    return NextResponse.json({ sent: true });
  } catch (err) {
    console.error("/api/appointments/request-otp", err);
    return NextResponse.json({ error: "Couldn't send the code right now. Please try again." }, { status: 500 });
  }
}