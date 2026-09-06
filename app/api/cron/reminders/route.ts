// ─────────────────────────────────────────────────────────────────────────────
// Automatic appointment reminders. A cron (GitHub Actions default, or Vercel
// cron) POSTs here every 15 minutes; this route decides which appointments are
// due RIGHT NOW and sends each ONCE. Not a staff action — /admin/broadcast
// stays manual for ad-hoc notices. Rule, one send max per appointment:
//   - future-day slots get a 7:00 PM IST nudge the evening before;
//   - same-day slots (whose evening-before has already passed) get the
//     60-minute net, so a patient who booked today still hears "today at 5pm".
// Idempotent via appointments.reminder_sent_at (a conditional update wins the
// race between overlapping ticks). Feature-gated on META_TEMPLATE_REMINDER:
// until the reminder template is approved and the env var is set, the cron
// wakes, sees no template, and does nothing — plenty safe to deploy first.
// The endpoint is not open: CRON_SECRET must match or it 401s (an exposed
// trigger here would spam real patients). `?test=1` (same secret) dry-runs the
// plan without sending, so the rule can be inspected before it fires live.
// ─────────────────────────────────────────────────────────────────────────────
import { NextResponse, type NextRequest } from "next/server";
import { safeEqual, sendReminder } from "@/lib/meta-whatsapp";
import { dbApptsForDate, dbMarkReminderSent, dbClearReminderSent } from "@/lib/db";
import { ymd, nowIST } from "@/lib/schedule";
import { hasSupabase } from "@/lib/supabase";
import type { Appt, ApptStatus } from "@/lib/store";

export const dynamic = "force-dynamic";

// The states a patient can still be reminded about. Consulting are with the
// doctor; done/cancelled are gone.
const REMINDABLE: ApptStatus[] = ["reserved", "confirmed", "waiting"];
const NET_LEAD_MS = 60 * 60 * 1000; // same-day net: one hour before the slot
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// When an appointment's single reminder should fire (IST instant), and whether
// it's due as of `now`. All arithmetic is on instants built from explicit
// +05:30 offset strings, so the answer is identical on a UTC or IST server.
function reminderPlan(a: Appt, now: Date): { sendAt: Date; due: boolean } {
  const slot = new Date(`${a.date}T${a.time}:00+05:30`);
  if (!(slot.getTime() > now.getTime())) return { sendAt: slot, due: false }; // past slot, never
  const midnight = new Date(`${a.date}T00:00:00+05:30`).getTime();
  const evening = new Date(midnight - MS_PER_DAY + 19 * 60 * 60 * 1000); // prior day, 19:00 IST
  // Tomorrow-or-later slots keep the evening nudge; a same-day slot's evening
  // has gone, so fall to the net. (String compare is fine for YYYY-MM-DD.)
  const sendAt = a.date > ymd(now) ? evening : new Date(slot.getTime() - NET_LEAD_MS);
  return { sendAt, due: now.getTime() >= sendAt.getTime() && now.getTime() < slot.getTime() };
}

export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const auth = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!secret || !auth || !safeEqual(secret.trim(), auth.trim())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!process.env.META_TEMPLATE_REMINDER) {
    return NextResponse.json({ status: "not-configured", reason: "META_TEMPLATE_REMINDER not set yet — no reminders until the template is approved" });
  }
  if (!hasSupabase()) {
    return NextResponse.json({ status: "mock-mode", reason: "no Supabase env on this deployment" });
  }

  const isTest = req.nextUrl.searchParams.get("test") === "1";
  const now = nowIST();
  const tomorrow = new Date(now.getTime() + MS_PER_DAY);
  const dates = [ymd(now), ymd(tomorrow)]; // only today + tomorrow can ever be due
  const rows = (await Promise.all(dates.map((d) => dbApptsForDate(d)))).flat();

  const planned: Array<{ id: string; name: string; date: string; time: string; status: ApptStatus; sendAt: string; due: boolean }> = [];
  const sends: Array<{ id: string; ok: boolean }> = [];

  for (const a of rows) {
    if (!REMINDABLE.includes(a.status) || !a.phone || a.reminderSentAt) continue;
    const plan = reminderPlan(a, now);
    planned.push({ id: a.id, name: a.name, date: a.date, time: a.time, status: a.status, sendAt: plan.sendAt.toISOString(), due: plan.due });
    if (!plan.due || isTest) continue;
    // Only the tick that actually sets the flag gets to send, so two
    // overlapping cron runs can't double-message a patient.
    const won = await dbMarkReminderSent(a.id);
    if (!won) continue;
    const ok = await sendReminder(a.phone, a.name, a.date, a.time);
    if (!ok) await dbClearReminderSent(a.id); // transient failure → retry next tick
    sends.push({ id: a.id, ok });
  }

  return NextResponse.json({
    now: now.toISOString(),
    dates,
    scanned: rows.length,
    template: process.env.META_TEMPLATE_REMINDER,
    ...(isTest
      ? { test: true, planned }
      : { sent: sends.length, ok: sends.filter((s) => s.ok).length, failed: sends.filter((s) => !s.ok).length, sends }),
  });
}