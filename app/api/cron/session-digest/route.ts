// ─────────────────────────────────────────────────────────────────────────────
// Pre-session email digest. A cron (GitHub Actions, every 15 min like the
// reminder cron) POSTs here; each tick finds today's clinic sessions that are
// about to start (within a lead window) and emails the clinic a list of
// everyone booked for that session — a Morning/Afternoon/Evening digest so the
// desk knows who to expect. Not a staff action; nothing in /admin triggers it.
// Idempotent via public.session_digest_sent, one row per (date, window_start):
// a window's digest is sent once, when it first becomes due, never again.
// Feature-gated on RESEND_API_KEY: until email is configured the cron wakes,
// sees no key, and does nothing — safe to deploy first. The endpoint is not
// open: CRON_SECRET must match or it 401s. `?test=1` (same secret) dry-runs
// the plan without sending or marking anything sent.
// ─────────────────────────────────────────────────────────────────────────────
import { NextResponse, type NextRequest } from "next/server";
import { safeEqual } from "@/lib/meta-whatsapp";
import {
  dbLoadSchedule, dbApptsForDate,
  dbMarkSessionDigestSent, dbClearSessionDigestSent,
} from "@/lib/db";
import { windowsFor, ymd, nowIST } from "@/lib/schedule";
import { sendSessionDigestEmail } from "@/lib/mailer";
import { hasSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// A session's label by when its window starts. Minutes so it stays correct if
// the clinic's hours ever shift, rather than a fixed index into the windows.
function sessionLabel(startMin: number): string {
  return startMin < 14 * 60 ? "Morning" : startMin < 17 * 60 ? "Afternoon" : "Evening";
}

const toMin = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};

// Fire a session's digest within this lead time before it starts, so staff get
// the list a little ahead rather than at the last minute.
const LEAD_MIN = 45;

export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const auth = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!secret || !auth || !safeEqual(secret.trim(), auth.trim())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!process.env.RESEND_API_KEY) {
    return NextResponse.json({ status: "not-configured", reason: "RESEND_API_KEY not set yet — no session digests until email is configured" });
  }
  if (!hasSupabase()) {
    return NextResponse.json({ status: "mock-mode", reason: "no Supabase env on this deployment" });
  }

  const isTest = req.nextUrl.searchParams.get("test") === "1";
  const now = nowIST();
  const date = ymd(now);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const sched = await dbLoadSchedule();
  const windows = windowsFor(now, sched);
  // Fetch today's rows once and bucket them per window below.
  const todays = (await dbApptsForDate(date)).filter((a) => a.status !== "cancelled");

  const planned: Array<{ label: string; window: string; due: boolean; appts: number }> = [];
  const sends: Array<{ label: string; window: string; ok: boolean }> = [];

  for (const win of windows) {
    const startMin = toMin(win.start);
    const label = sessionLabel(startMin);
    // Due when the session hasn't started yet and is within the lead window.
    const due = nowMin <= startMin && startMin - nowMin <= LEAD_MIN;
    const appts = todays.filter((a) => a.time >= win.start && a.time < win.end);
    planned.push({ label, window: win.start, due, appts: appts.length });
    if (!due || isTest || !appts.length) continue;
    // Only the tick that inserts the (date, window_start) row gets to send, so
    // two overlapping cron runs can't double-email the same session.
    const won = await dbMarkSessionDigestSent(date, win.start);
    if (!won) continue;
    const ok = await sendSessionDigestEmail(label, date, appts);
    if (!ok) await dbClearSessionDigestSent(date, win.start); // transient failure → retry next tick
    sends.push({ label, window: win.start, ok });
  }

  return NextResponse.json({
    now: now.toISOString(),
    date,
    scanned: windows.length,
    ...(isTest
      ? { test: true, planned }
      : { sent: sends.length, ok: sends.filter((s) => s.ok).length, failed: sends.filter((s) => !s.ok).length, sends }),
  });
}
