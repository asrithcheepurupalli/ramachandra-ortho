// ─────────────────────────────────────────────────────────────────────────────
// End-of-day reconciliation email. A cron (cron-job.org, once a day around 9:00
// PM IST / 15:30 UTC) POSTs here; this route lists every one of today's active
// appointments (Morning + Evening) and emails the clinic admin a single
// cross-check digest before closing. Not a staff action; nothing in /admin
// triggers this manually. Idempotent via public.daily_digest_sent (one row per
// IST date), since this fires once for the whole day — so an EARLIEST_HOUR_IST
// gate below matters: this route is triggered by exactly one external daily
// schedule, not a repeating poll like the other crons, so if that schedule is
// ever misconfigured (e.g. an anchor time entered without accounting for the
// IST/UTC offset) it can fire hours early, consume the day's one send slot,
// and leave the desk with either nothing at 9pm or a digest sent long before
// the day's bookings were even final. The gate below refuses to consume that
// slot before evening, so a botched early trigger is a visible no-op instead
// of a silent, incomplete send that also blocks the real one later that day.
// Feature-gated on RESEND_API_KEY: until email is configured the cron wakes,
// sees no key, and does nothing — safe to deploy first. The endpoint is not
// open: CRON_SECRET must match or it 401s. `?test=1` (same secret) dry-runs
// the plan without sending, marking sent, or being subject to the hour gate.
// ─────────────────────────────────────────────────────────────────────────────
import { NextResponse, type NextRequest } from "next/server";
import { safeEqual } from "@/lib/meta-whatsapp";
import { dbApptsForDate, dbMarkDailyDigestSent, dbClearDailyDigestSent } from "@/lib/db";
import { ymd, nowIST } from "@/lib/schedule";
import { sendEndOfDayDigestEmail } from "@/lib/mailer";
import { hasSupabase } from "@/lib/supabase";
import { reportError } from "@/lib/bugdesk";

export const dynamic = "force-dynamic";

// Refuse to send (or consume the once-a-day slot) any earlier than this IST
// hour. An hour of slack before the intended 9pm anchor covers a slightly
// early trigger without letting a badly wrong one (e.g. firing just after
// midnight, ~20 hours off) through.
const EARLIEST_HOUR_IST = 20;

export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const extSecret = process.env.EXT_CRON_SECRET;
  const auth = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const authenticated = (secret && safeEqual(secret.trim(), auth.trim())) || (extSecret && safeEqual(extSecret.trim(), auth.trim()));
  if (!authenticated) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!process.env.RESEND_API_KEY) {
    return NextResponse.json({ status: "not-configured", reason: "RESEND_API_KEY not set yet — no daily digest until email is configured" });
  }
  if (!hasSupabase()) {
    return NextResponse.json({ status: "mock-mode", reason: "no Supabase env on this deployment" });
  }

  try {
    const isTest = req.nextUrl.searchParams.get("test") === "1";
    const now = nowIST();
    const date = ymd(now);
    if (!isTest && now.getHours() < EARLIEST_HOUR_IST) {
      const hh = String(now.getHours()).padStart(2, "0");
      const mm = String(now.getMinutes()).padStart(2, "0");
      return NextResponse.json({ status: "too-early", reason: `daily digest only sends at or after ${EARLIEST_HOUR_IST}:00 IST`, nowIST: `${date} ${hh}:${mm}`, date });
    }
    // "Active" for this reconciliation means actually booked: cancelled rows
    // are dead, and payment_pending rows are unpaid holds that were never
    // confirmed (nothing confirms a booking until the Razorpay webhook or a
    // free-review claim flips it) — including either in the desk's end-of-day
    // cross-check misreports a hold that may have already expired as a real,
    // unpaid appointment.
    const active = (await dbApptsForDate(date)).filter((a) => a.status !== "cancelled" && a.status !== "payment_pending");

    if (isTest) {
      return NextResponse.json({ date, active: active.length, test: true });
    }
    if (!active.length) {
      return NextResponse.json({ status: "no-appointments", date });
    }

    const won = await dbMarkDailyDigestSent(date);
    if (!won) {
      return NextResponse.json({ status: "already-sent", date });
    }
    const ok = await sendEndOfDayDigestEmail(date, active);
    if (!ok) await dbClearDailyDigestSent(date); // transient failure → allow a retry
    return NextResponse.json({ date, active: active.length, sent: ok });
  } catch (err) {
    console.error("/api/cron/daily-digest", err);
    // The end-of-day reconciliation failed outright — the desk won't get a
    // cross-check before closing.
    await reportError("cron/daily-digest", err, { severity: "critical" });
    return NextResponse.json({ error: "cron failed" }, { status: 500 });
  }
}
