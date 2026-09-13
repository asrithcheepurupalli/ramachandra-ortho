// ─────────────────────────────────────────────────────────────────────────────
// Daily doctor WhatsApp digest. A cron (GitHub Actions, once a day at 7:30 AM
// IST) POSTs here; this route lists today's active appointments and sends the
// doctor a single summary. Not a staff action — nothing in /admin or /doctor
// triggers this manually. Idempotent via public.doctor_digest_sent (one row
// per IST date), since this fires once for the whole day, not once per
// appointment (unlike /api/cron/reminders). Feature-gated on
// META_TEMPLATE_DOCTOR_DIGEST: until the template is approved and the env var
// is set, the cron wakes, sees no template, and does nothing. The endpoint is
// not open: CRON_SECRET must match or it 401s. `?test=1` (same secret)
// dry-runs the plan without sending or marking sent.
// ─────────────────────────────────────────────────────────────────────────────
import { NextResponse, type NextRequest } from "next/server";
import { safeEqual, sendDoctorDigest } from "@/lib/meta-whatsapp";
import { dbApptsForDate, dbMarkDoctorDigestSent } from "@/lib/db";
import { ymd, nowIST } from "@/lib/schedule";
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
  if (!process.env.META_TEMPLATE_DOCTOR_DIGEST) {
    return NextResponse.json({ status: "not-configured", reason: "META_TEMPLATE_DOCTOR_DIGEST not set yet — no digest until the template is approved" });
  }
  if (!hasSupabase()) {
    return NextResponse.json({ status: "mock-mode", reason: "no Supabase env on this deployment" });
  }

  try {
    const isTest = req.nextUrl.searchParams.get("test") === "1";
    const date = ymd(nowIST());
    const appts = await dbApptsForDate(date);
    const active = appts.filter((a) => a.status !== "cancelled");

    if (isTest) {
      return NextResponse.json({ date, scanned: appts.length, active: active.length, test: true });
    }

    const won = await dbMarkDoctorDigestSent(date);
    if (!won) {
      return NextResponse.json({ status: "already-sent", date });
    }
    const ok = await sendDoctorDigest(active);
    return NextResponse.json({ date, active: active.length, sent: ok });
  } catch (err) {
    console.error("/api/cron/doctor-digest", err);
    // The doctor's daily summary failed outright — they may not know who's in.
    await reportError("cron/doctor-digest", err, { severity: "critical" });
    return NextResponse.json({ error: "cron failed" }, { status: 500 });
  }
}
