// ─────────────────────────────────────────────────────────────────────────────
// Free-review-visit nudge. A cron (GitHub Actions, once daily at 8:00 AM IST)
// POSTs here; this route finds patients who CONSULTED within the last 10 days
// (appointment status done, and the visit itself was NOT a free review) but
// have NOT booked their free follow-up review visit, and nudges each once to
// come utilize it. Idempotent via appointments.free_visit_reminder_sent_at,
// stamped on the EARNING consultation appointment. Feature-gated on
// META_TEMPLATE_FREE_REVIEW_NUDGE; CRON_SECRET-gated; `?test=1` dry-runs.
// ─────────────────────────────────────────────────────────────────────────────
import { NextResponse, type NextRequest } from "next/server";
import { safeEqual, sendFreeReviewNudge } from "@/lib/meta-whatsapp";
import { dbDoneAppointmentsBetween, dbHasFutureFreeBooking, dbMarkFreeVisitNudgeSent, dbClearFreeVisitNudgeSent, dbRetireFreeVisitNudges } from "@/lib/db";
import { ymd, nowIST } from "@/lib/schedule";
import { hasSupabase } from "@/lib/supabase";
import { reportError } from "@/lib/bugdesk";
import { normalizePhone } from "@/lib/phone";
import type { Appt } from "@/lib/store";

export const dynamic = "force-dynamic";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const REVIEW_WINDOW_DAYS = 10;

// Ordered newest-first (latest consultation first) so the per-phone dedupe
// below naturally keeps a patient's most recent visit.
function byNewest(a: Appt, b: Appt): number {
  return b.date.localeCompare(a.date) || b.time.localeCompare(a.time);
}

export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const auth = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!secret || !auth || !safeEqual(secret.trim(), auth.trim())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!process.env.META_TEMPLATE_FREE_REVIEW_NUDGE) {
    return NextResponse.json({ status: "not-configured", reason: "META_TEMPLATE_FREE_REVIEW_NUDGE not set yet — no nudges until the template is approved" });
  }
  if (!hasSupabase()) {
    return NextResponse.json({ status: "mock-mode", reason: "no Supabase env on this deployment" });
  }

  try {
    const isTest = req.nextUrl.searchParams.get("test") === "1";
    const now = nowIST();
    const startDate = ymd(new Date(now.getTime() - REVIEW_WINDOW_DAYS * MS_PER_DAY));
    const endDate = ymd(now);
    const rows = await dbDoneAppointmentsBetween(startDate, endDate);

    // Only consultations that EARN a free visit qualify: status done (already
    // filtered), has a phone to reach, was not itself a free visit (a free
    // visit doesn't earn a free visit), and hasn't already been nudged.
    const eligible = rows
      .filter((a) => a.phone && a.claimType !== "review_free" && !a.freeVisitReminderSentAt)
      .sort(byNewest);

    // One nudge per patient: keep only each phone's most recent earned visit
    // (rows are newest-first, so the first time a phone appears wins). The
    // canonical 10-digit form is the group key, matching how patients store it.
    const seenPhones = new Set<string>();
    const candidates: Appt[] = [];
    for (const a of eligible) {
      const key = normalizePhone(a.phone);
      if (!key || seenPhones.has(key)) continue;
      seenPhones.add(key);
      candidates.push(a);
    }

    // Skip anyone who already booked their free review (the visit is served —
    // no need to push them to book it). Cancelled free bookings don't count,
    // so a patient who booked then cancelled is still eligible.
    const planned: Array<{ id: string; name: string; phone: string; date: string; time: string; alreadyBooked: boolean }> = [];
    const sends: Array<{ id: string; ok: boolean }> = [];

    for (const a of candidates) {
      const alreadyBooked = await dbHasFutureFreeBooking(a.phone, ymd(now));
      planned.push({ id: a.id, name: a.name, phone: a.phone, date: a.date, time: a.time, alreadyBooked });
      if (alreadyBooked || isTest) continue;
      // Same mark-then-send race guard: only the tick that sets the flag sends.
      const won = await dbMarkFreeVisitNudgeSent(a.id);
      if (!won) continue;
      const ok = await sendFreeReviewNudge(a.phone, a.name);
      if (ok) {
        // One nudge per patient: retire this phone's other in-window visits so
        // an older one can't re-nudge them on a later run.
        await dbRetireFreeVisitNudges(a.phone, startDate, a.id);
      } else {
        await dbClearFreeVisitNudgeSent(a.id); // transient failure → retry next tick
      }
      sends.push({ id: a.id, ok });
    }

    return NextResponse.json({
      now: now.toISOString(),
      window: { start: startDate, end: endDate },
      scanned: rows.length,
      template: process.env.META_TEMPLATE_FREE_REVIEW_NUDGE,
      ...(isTest
        ? { test: true, planned }
        : { sent: sends.length, ok: sends.filter((s) => s.ok).length, failed: sends.filter((s) => !s.ok).length, sends }),
    });
  } catch (err) {
    console.error("/api/cron/free-visit-nudge", err);
    // A failed tick may silently miss real patients' free-visit nudges. Escalate.
    await reportError("cron/free-visit-nudge", err, { severity: "critical" });
    return NextResponse.json({ error: "cron failed" }, { status: 500 });
  }
}