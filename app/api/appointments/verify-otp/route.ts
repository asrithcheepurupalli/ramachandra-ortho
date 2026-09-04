// Public: check a phone's verification code and, on success, mark that phone
// verified server-side so the mutation routes accept the caller's session —
// one code proof per self-service session, single-use.
import { NextResponse, type NextRequest } from "next/server";
import { consumeOtp, markVerified, otpEnabled } from "@/lib/otp";

const RATE_LIMIT = 20;
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
  const { phone, code } = body ?? {};
  if (typeof phone !== "string" || !phone.trim()) return NextResponse.json({ error: "phone is required" }, { status: 400 });
  if (typeof code !== "string" || code.trim().length !== 6) return NextResponse.json({ error: "Enter the 6-digit code" }, { status: 400 });
  if (!otpEnabled()) return NextResponse.json({ error: "Verification isn't set up yet" }, { status: 503 });

  const result = consumeOtp(phone.trim(), code.trim());
  if (result === "none") return NextResponse.json({ error: "That code has expired. Tap send again for a new one." }, { status: 410 });
  if (result === "bad") return NextResponse.json({ error: "That code didn't match. Check it and try again." }, { status: 401 });
  markVerified(phone.trim());
  return NextResponse.json({ verified: true });
}