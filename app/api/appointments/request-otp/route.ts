// Public: send a one-time verification code to a phone, as WhatsApp template
// ortho_verification_code. Callable by anyone, but only meaningful for a
// number with an active appointment — the code is the ownership proof the
// self-service mutation routes (cancel / reschedule / pay) now require, so a
// stranger who merely knows a patient's phone number can no longer touch
// their booking.
//
// ── Template contract (paste this EXACT body into Meta's composer) ──────────
//   Name:     ortho_verification_code
//   Category: Utility — NOT "Authentication". The Authentication (one-time
//             passcode) category makes Meta generate the code and auto-fill it
//             into a native app; we need the code generated server-side and
//             typed into a web page, so it must be a Utility body with a {{1}}.
//   Language: English (IND) — the composer offers en_IN here, and
//             META_TEMPLATE_LANG_OTP must match whatever the approved language
//             code ends up being (en_IN, or en if offered).
//   Body:     Your Ramachandra Ortho Care verification code is {{1}}. Enter it
//             on the appointment page within 5 minutes to confirm your number.
//             Do not share this code with anyone.
//
// Meta rejects a body that fails its length/variable rules, which will surface
// as "too many variables for its length" or "variables can't be at the start
// or end of the template" in the composer. The safe shape is exactly one {{1}}
// placeholder, sat mid-sentence with plain text before it and after it, and a
// body long enough that the 6-digit sample value doesn't dominate it. This
// route sends exactly one text parameter ({type:"text"}), so keep {{1}} the
// only placeholder and the code the only thing it receives — never two
// {{n}}s, never a placeholder slapped at the very start or end of the line.
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

    const code = requestOtp(phone.trim());
    if (!code) return NextResponse.json({ error: "A code was recently sent. Please try again in a few minutes." }, { status: 429 });

    const sent = await sendVerificationCode(phone.trim(), code);
    if (!sent) return NextResponse.json({ error: "Couldn't send the code right now. Please try again." }, { status: 502 });
    return NextResponse.json({ sent: true });
  } catch (err) {
    console.error("/api/appointments/request-otp", err);
    return NextResponse.json({ error: "Couldn't send the code right now. Please try again." }, { status: 500 });
  }
}