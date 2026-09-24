// ─────────────────────────────────────────────────────────────────────────────
// End-of-day reconciliation email. A cron (GitHub Actions, once a day at 9:00
// PM IST / 15:30 UTC) POSTs here; this route lists every one of today's active
// appointments (Morning + Evening) and emails the clinic admin a single
// cross-check digest before closing. Not a staff action; nothing in /admin
// triggers this manually. Idempotent via public.daily_digest_sent (one row per
// IST date), since this fires once for the whole day. Feature-gated on
// RESEND_API_KEY: until email is configured the cron wakes, sees no key, and
// does nothing — safe to deploy first. The endpoint is not open: CRON_SECRET
// must match or it 401s. `?test=1` (same secret) dry-runs the plan without
// sending or marking sent.
// ─────────────────────────────────────────────────────────────────────────────
import { NextResponse, type NextRequest } from "next/server";
import { safeEqual } from "@/lib/meta-whatsapp";
import { dbApptsForDate, dbMarkDailyDigestSent, dbClearDailyDigestSent } from "@/lib/db";
import { ymd, nowIST } from "@/lib/schedule";
import { sendEndOfDayDigestEmail } from "@/lib/mailer";
import { hasSupabase } from "@/lib/supabase";
import { reportError } from "@/lib/bugdesk";

export const dynamic = "force-dynamic";

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
    const date = ymd(nowIST());
    const active = (await dbApptsForDate(date)).filter((a) => a.status !== "cancelled");

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
