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

// Seeded from the clinic's listed OPD windows. Fully editable in admin.
// Saturday is intentionally empty by default (mostly off, adjustable per week).
export const weeklyHours: WeeklyHours = {
  0: [], // Sun closed
  1: [{ start: "10:00", end: "11:00" }], // Mon
  2: [{ start: "18:00", end: "20:00" }], // Tue (evening OPD)
  3: [{ start: "19:00", end: "20:00" }], // Wed
  4: [{ start: "18:00", end: "20:00" }], // Thu (evening OPD)
  5: [{ start: "18:00", end: "19:00" }], // Fri
  6: [], // Sat — adjustable; add an exception to open it
};

// Date-specific overrides. key = "YYYY-MM-DD".
//   closed: true            → doctor away that day (e.g. a Saturday he can't make)
//   windows: Window[]       → custom hours that day (e.g. an open Saturday)
//   note: string            → shown to patients ("At surgery until 5 PM")
export type Exception = { closed?: boolean; windows?: Window[]; note?: string };
export const exceptions: Record<string, Exception> = {};

// ── helpers ──────────────────────────────────────────────────────────────────
export const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;

const toMin = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};
export const fmt = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  const am = h < 12;
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr}${m ? ":" + String(m).padStart(2, "0") : ""} ${am ? "AM" : "PM"}`;
};

export function windowsFor(date: Date): Window[] {
  const ex = exceptions[ymd(date)];
  if (ex?.closed) return [];
  if (ex?.windows) return ex.windows;
  return weeklyHours[date.getDay()] ?? [];
}

export type Status =
  | { state: "in"; until: string; note?: string }
  | { state: "soon"; opensAt: string; note?: string }
  | { state: "out"; next?: { date: Date; opensAt: string }; note?: string };

// Manual override the front desk can flip for today ("doctor stepped in / out"),
// independent of the weekly schedule. Wins over the schedule for today only.
export type Override = { date: string; mode: "in" | "out" };
export const overrideRef: { current: Override | null } = { current: null };
export function setOverride(o: Override | null) {
  overrideRef.current = o;
}

// next open window in the coming 14 days
function nextOpen(now: Date): { date: Date; opensAt: string } | undefined {
  for (let i = 1; i <= 14; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() + i);
    const w = windowsFor(d)[0];
    if (w) return { date: d, opensAt: w.start };
  }
  return undefined;
}

export function statusAt(now = new Date()): Status {
  const note = exceptions[ymd(now)]?.note;

  // manual override for today wins
  const ov = overrideRef.current;
  if (ov && ov.date === ymd(now)) {
    if (ov.mode === "out")
      return { state: "out", next: nextOpen(now), note: note ?? "Marked away today" };
    const wins = windowsFor(now);
    return { state: "in", until: wins.length ? wins[wins.length - 1].end : "21:00", note };
  }

  const mins = now.getHours() * 60 + now.getMinutes();
  const today = windowsFor(now);
  for (const w of today) {
    if (mins >= toMin(w.start) && mins < toMin(w.end))
      return { state: "in", until: w.end, note };
  }
  const laterToday = today.find((w) => toMin(w.start) > mins);
  if (laterToday) return { state: "soon", opensAt: laterToday.start, note };

  return { state: "out", next: nextOpen(now), note };
}

// Bookable slots for a given date (respects windows, minus already-taken).
export function slotsFor(date: Date, taken: string[] = []): string[] {
  const out: string[] = [];
  for (const w of windowsFor(date)) {
    for (let m = toMin(w.start); m < toMin(w.end); m += clinic.slotMinutes) {
      const t = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(
        m % 60
      ).padStart(2, "0")}`;
      if (!taken.includes(t)) out.push(t);
    }
  }
  return out;
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
