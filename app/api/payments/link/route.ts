// Public: get (or create) a Razorpay payment link for one of the caller's own
// active, unpaid appointments. Same two-step ownership proof as
// /api/appointments/*: the phone must match one of that number's own active
// appointments AND have verified itself with a one-time SIM code before a
// link is produced.
import { NextResponse, type NextRequest } from "next/server";
import { dbGetOrCreatePaymentLink } from "@/lib/db";
import { otpVerified, otpEnabled } from "@/lib/otp";

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
  const { id, phone } = body ?? {};
  if (typeof id !== "string" || !id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  if (typeof phone !== "string" || !phone.trim()) return NextResponse.json({ error: "phone is required" }, { status: 400 });

  try {
    if (otpEnabled() && !otpVerified(phone.trim())) {
      return NextResponse.json({ error: "Verify your number to continue", otpRequired: true }, { status: 401 });
    }
    const url = await dbGetOrCreatePaymentLink(id, phone.trim());
    return NextResponse.json({ url });
  } catch (err) {
    if (err instanceof Error && err.message === "not_found") {
      return NextResponse.json({ error: "Appointment not found" }, { status: 404 });
    }
    if (err instanceof Error && err.message === "already_paid") {
      return NextResponse.json({ error: "This appointment is already paid" }, { status: 400 });
    }
    if (err instanceof Error && err.message === "razorpay_unavailable") {
      return NextResponse.json({ error: "Payments aren't available right now. Please try again shortly." }, { status: 502 });
    }
    console.error("/api/payments/link", err);
    return NextResponse.json({ error: "Could not start payment" }, { status: 500 });
  }
}
