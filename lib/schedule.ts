// ─────────────────────────────────────────────────────────────────────────────
// Availability engine — the single source of truth for "is the doctor in?".
// The site banner, the WhatsApp auto-reply, and the bookable slots all read
// from here. In production this is backed by Supabase; for the beta it's a
// seeded in-memory template the admin schedule editor mutates.
// ─────────────────────────────────────────────────────────────────────────────
import { clinic } from "@/clinic.config";

export type Window = { start: string; end: string }; // "HH:MM" 24h
// 0 = Sunday … 6 = Saturday
export type WeeklyHours = Record<number, Window[]>;

// Seeded from the clinic's listed OPD windows: Mon–Sat, morning and evening.
// Sunday is a holiday. Fully editable in admin.
const OPD: Window[] = [{ start: "10:00", end: "12:30" }, { start: "18:00", end: "19:45" }];
export const weeklyHours: WeeklyHours = {
  0: [], // Sun — holiday
  1: OPD, // Mon
  2: OPD, // Tue
  3: OPD, // Wed
  4: OPD, // Thu
  5: OPD, // Fri
  6: OPD, // Sat
};

// weeklyHours gets overwritten in place by applySchedule() (admin edits,
// hydrated from localStorage) — so it's not a safe value to reset to. This
// returns a fresh copy of the clinic's real default, untouched by any of that.
export function defaultWeeklyHours(): WeeklyHours {
  const fresh: Window[] = [{ start: "10:00", end: "12:30" }, { start: "18:00", end: "19:45" }];
  return {
    0: [],
    1: fresh.map((w) => ({ ...w })),
    2: fresh.map((w) => ({ ...w })),
    3: fresh.map((w) => ({ ...w })),
    4: fresh.map((w) => ({ ...w })),
    5: fresh.map((w) => ({ ...w })),
    6: fresh.map((w) => ({ ...w })),
  };
}

// Date-specific overrides. key = "YYYY-MM-DD".
//   closed: true            → doctor away that day (e.g. a Saturday he can't make)
//   windows: Window[]       → custom hours that day (e.g. an open Saturday)
//   note: string            → shown to patients ("At surgery until 5 PM")
export type Exception = { closed?: boolean; windows?: Window[]; note?: string };
export const exceptions: Record<string, Exception> = {};

// ── helpers ──────────────────────────────────────────────────────────────────

// The clinic's own wall-clock. Every "what is today" / "what time is it right
// now" decision below (ymd/statusAt/windowsFor/slotsFor's callers) reads a
// Date through LOCAL getters (getHours/getDate/getDay/...) — correct as-is
// when the caller is a patient's or staff's own browser (already IST for
// anyone in India), but wrong when the caller is a server route: Vercel's
// Node runtime is UTC, so a bare `new Date()` there is up to 5.5h off
// Asia/Kolkata (UTC+5:30, no DST) — enough to shift the calendar date itself
// near midnight IST. Every server-side "now" must go through this, not
// `new Date()` directly. Computed from the actual runtime offset (not assumed
// to be UTC) so it's correct in any process TZ, including a dev machine that
// already happens to run in IST.
export function nowIST(): Date {
  const now = new Date();
  const istOffsetMin = -330; // Asia/Kolkata is fixed UTC+5:30
  const driftMin = now.getTimezoneOffset() - istOffsetMin;
  return new Date(now.getTime() + driftMin * 60_000);
}

export const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;

const toMin = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};
// Minimum lead time before a slot can be booked today (patients need time to
// travel). Was 10 min, same as clinic.slotMinutes — since a slot only clears
// this once it's >10 min out, and slots sit on a 10-min grid, the last slot
// of every window was unbookable for a full 20 min before the window closed
// (its own 10-min lead time plus the next slot's already having dropped off),
// which read as "no slots" well before the window was actually done. 5 min
// halves that blackout without dropping the lead-time protection entirely.
export const BOOKING_LEAD_MIN = 5;

export const fmt = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  const am = h < 12;
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr}${m ? ":" + String(m).padStart(2, "0") : ""} ${am ? "AM" : "PM"}`;
};

// Manual override the front desk can flip for today ("doctor stepped in / out"),
// independent of the weekly schedule. Wins over the schedule for today only.
export type Override = { date: string; mode: "in" | "out" };
export const overrideRef: { current: Override | null } = { current: null };
export function setOverride(o: Override | null) {
  overrideRef.current = o;
}

// Lightweight change notifier, decoupled from lib/store.ts's localStorage-bound
// listeners, so DB-mode admin components can force a re-render off each other
// when the schedule/override changes (mock mode keeps using lib/store.ts's
// useScheduleTick, which is localStorage-driven).
const scheduleListeners = new Set<() => void>();
export function onScheduleChange(l: () => void): () => void {
  scheduleListeners.add(l);
  return () => scheduleListeners.delete(l);
}
export function notifyScheduleChange() {
  scheduleListeners.forEach((l) => l());
}

// Everything windowsFor/statusAt/slotsFor need to compute availability. The
// module singletons below (weeklyHours/exceptions/overrideRef) only get
// populated in a browser tab via hydrateSchedule() — a server route (the
// WhatsApp webhook, /api/slots) has no tab, so it fetches this shape fresh
// from Supabase each request and passes it in explicitly instead.
export type SchedState = { weekly: WeeklyHours; exceptions: Record<string, Exception>; override: Override | null };
const liveState = (): SchedState => ({ weekly: weeklyHours, exceptions, override: overrideRef.current });

export function windowsFor(date: Date, s: SchedState = liveState()): Window[] {
  const ex = s.exceptions[ymd(date)];
  if (ex?.closed) return [];
  if (ex?.windows) return ex.windows;
  return s.weekly[date.getDay()] ?? [];
}

export type Status =
  | { state: "in"; until: string; note?: string }
  | { state: "soon"; opensAt: string; note?: string }
  | { state: "out"; next?: { date: Date; opensAt: string }; note?: string };

// next open window in the coming 14 days
function nextOpen(now: Date, s: SchedState): { date: Date; opensAt: string } | undefined {
  for (let i = 1; i <= 14; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() + i);
    const w = windowsFor(d, s)[0];
    if (w) return { date: d, opensAt: w.start };
  }
  return undefined;
}

export function statusAt(now = new Date(), s: SchedState = liveState()): Status {
  const note = s.exceptions[ymd(now)]?.note;

  // manual override for today wins
  const ov = s.override;
  if (ov && ov.date === ymd(now)) {
    if (ov.mode === "out")
      return { state: "out", next: nextOpen(now, s), note: note ?? "Marked away today" };
    const wins = windowsFor(now, s);
    return { state: "in", until: wins.length ? wins[wins.length - 1].end : "21:00", note };
  }

  const mins = now.getHours() * 60 + now.getMinutes();
  const today = windowsFor(now, s);
  for (const w of today) {
    if (mins >= toMin(w.start) && mins < toMin(w.end))
      return { state: "in", until: w.end, note };
  }
  const laterToday = today.find((w) => toMin(w.start) > mins);
  if (laterToday) return { state: "soon", opensAt: laterToday.start, note };

  return { state: "out", next: nextOpen(now, s), note };
}

// Every slot time in a date's windows, taken or not — the website booking
// page needs this to grey out taken slots instead of hiding them; the bot
// and the Flow endpoint only ever want the open subset, via slotsFor below.
export function allSlotsFor(date: Date, s: SchedState = liveState()): string[] {
  const out: string[] = [];
  for (const w of windowsFor(date, s)) {
    for (let m = toMin(w.start); m < toMin(w.end); m += clinic.slotMinutes) {
      out.push(`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);
    }
  }
  return out;
}

// Bookable slots for a given date (respects windows, minus already-taken).
export function slotsFor(date: Date, taken: string[] = [], s: SchedState = liveState()): string[] {
  return allSlotsFor(date, s).filter((t) => !taken.includes(t));
}

export const weekdayName = (d: Date) =>
  ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][
    d.getDay()
  ];

// Apply an edited schedule (from the admin editor) onto the live module objects,
// so statusAt()/slotsFor() reflect it immediately. In production this is one
// Supabase row that every surface reads.
export function applySchedule(w: WeeklyHours, ex: Record<string, Exception>) {
  for (let d = 0; d <= 6; d++) weeklyHours[d] = w[d] ?? [];
  for (const k of Object.keys(exceptions)) delete exceptions[k];
  Object.assign(exceptions, ex);
}
