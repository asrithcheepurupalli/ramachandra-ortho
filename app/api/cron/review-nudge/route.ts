// ─────────────────────────────────────────────────────────────────────────────
// Post-visit review nudge. A cron (GitHub Actions, every 15 minutes) POSTs here;
// this route sends each completed appointment a one-time "how was your visit?
// leave a Google review" template message, the SAME DAY, ~3 hours after the
// slot, once staff marked it done. Idempotent via appointments.review_nudge_sent_at
// (a conditional update wins the race, same as the reminder cron). Feature-gated
// on META_TEMPLATE_REVIEW_NUDGE: until the template is approved and the env var
// set, the cron wakes and does nothing — safe to deploy first. CRON_SECRET-gated
// like every cron (an exposed trigger would spam real patients); `?test=1`
// (same secret) dry-runs the plan without sending.
// ─────────────────────────────────────────────────────────────────────────────
import { NextResponse, type NextRequest } from "next/server";
import { safeEqual, sendReviewNudge } from "@/lib/meta-whatsapp";
import { dbApptsForDate, dbMarkReviewNudgeSent, dbClearReviewNudgeSent } from "@/lib/db";
import { ymd, nowIST } from "@/lib/schedule";
import { hasSupabase } from "@/lib/supabase";
import { reportError } from "@/lib/bugdesk";
import type { Appt } from "@/lib/store";

export const dynamic = "force-dynamic";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const NUDGE_DELAY_MS = 3 * 60 * 60 * 1000; // 3h after the slot start

// Whether a completed appointment's review nudge is due as of `now`: the nurse
// marks the visit done and the nudge goes out 3h after the SLOT (not after the
// done flip, which has no timestamp — appointments carry no status_changed_at).
// A late-marked visit still qualifies the moment now passes slot+3h. Built from
// an explicit +05:30 offset like reminderPlan, so the answer is identical on a
// UTC or IST server.
function reviewNudgeDue(a: Appt, now: Date): boolean {
  const slot = new Date(`${a.date}T${a.time}:00+05:30`).getTime();
  return now.getTime() >= slot + NUDGE_DELAY_MS;
}

export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const extSecret = process.env.EXT_CRON_SECRET;
  const auth = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const authenticated = (secret && safeEqual(secret.trim(), auth.trim())) || (extSecret && safeEqual(extSecret.trim(), auth.trim()));
  if (!authenticated) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!process.env.META_TEMPLATE_REVIEW_NUDGE) {
    return NextResponse.json({ status: "not-configured", reason: "META_TEMPLATE_REVIEW_NUDGE not set yet — no nudges until the template is approved" });
  }
  if (!hasSupabase()) {
    return NextResponse.json({ status: "mock-mode", reason: "no Supabase env on this deployment" });
  }

  try {
    const isTest = req.nextUrl.searchParams.get("test") === "1";
    const now = nowIST();
    const yesterday = new Date(now.getTime() - MS_PER_DAY);
    // Scan today + yesterday: same-day slots are caught ~3h after booking, and
    // a visit marked done hours late (past midnight IST) is caught the next day.
    const dates = [ymd(now), ymd(yesterday)];
    const rows = (await Promise.all(dates.map((d) => dbApptsForDate(d)))).flat();

    const planned: Array<{ id: string; name: string; date: string; time: string; status: string; due: boolean }> = [];
    const sends: Array<{ id: string; ok: boolean }> = [];

    for (const a of rows) {
      if (a.status !== "done" || !a.phone || a.reviewNudgeSentAt) continue;
      const due = reviewNudgeDue(a, now);
      planned.push({ id: a.id, name: a.name, date: a.date, time: a.time, status: a.status, due });
      if (!due || isTest) continue;
      // Only the tick that actually sets the flag gets to send, so two
      // overlapping cron runs can't double-nudge a patient.
      const won = await dbMarkReviewNudgeSent(a.id);
      if (!won) continue;
      const ok = await sendReviewNudge(a.phone, a.name);
      if (!ok) await dbClearReviewNudgeSent(a.id); // transient failure → retry next tick
      sends.push({ id: a.id, ok });
    }

    return NextResponse.json({
      now: now.toISOString(),
      dates,
      scanned: rows.length,
      template: process.env.META_TEMPLATE_REVIEW_NUDGE,
      ...(isTest
        ? { test: true, planned }
        : { sent: sends.length, ok: sends.filter((s) => s.ok).length, failed: sends.filter((s) => !s.ok).length, sends }),
    });
  } catch (err) {
    console.error("/api/cron/review-nudge", err);
    // A failed tick may silently miss real patients' review nudges. Escalate.
    await reportError("cron/review-nudge", err, { severity: "critical" });
    return NextResponse.json({ error: "cron failed" }, { status: 500 });
  }
}