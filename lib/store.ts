"use client";
// ─────────────────────────────────────────────────────────────────────────────
// Mock data store (localStorage-backed) so the whole product runs zero-config.
// In production this is Supabase; every function here maps 1:1 to a table.
// ─────────────────────────────────────────────────────────────────────────────
import { useSyncExternalStore } from "react";
import { clinic } from "@/clinic.config";
import {
  ymd, weeklyHours, exceptions, applySchedule, setOverride, overrideRef, windowsFor,
  type WeeklyHours, type Exception, type Override,
} from "@/lib/schedule";

export type ApptStatus =
  | "reserved" | "confirmed" | "waiting" | "consulting" | "done" | "cancelled";
export type Source = "website" | "whatsapp" | "walkin";

export type Appt = {
  id: string;
  token: number;
  name: string;
  phone: string;
  reason: string;
  date: string; // YYYY-MM-DD
  time: string; // HH:MM
  status: ApptStatus;
  source: Source;
  fee: number;
  paid: boolean;
  createdAt: number;
};

const KEY = "roc.appts.v1";

const rid = () => Math.random().toString(36).slice(2, 9);

// ── seed: a realistic OPD day so the dashboard is alive on first load ────────
function seed(): Appt[] {
  const today = ymd(new Date());
  const fee = clinic.consultationFee;
  const rows: [string, string, string, Source, ApptStatus, boolean][] = [
    ["Lakshmi Devi", "9848012345", "Knee pain, difficulty walking", "website", "done", true],
    ["Ravi Teja", "9701123456", "Fracture follow-up (left wrist)", "whatsapp", "done", true],
    ["Suresh Kumar", "9885234567", "Lower back pain", "walkin", "done", true],
    ["Anjali Rao", "9963345678", "Post-op knee review", "website", "consulting", true],
    ["Md. Imran", "9848456789", "Shoulder dislocation", "whatsapp", "waiting", false],
    ["Padma Sri", "9701567890", "Ankle sprain, sports injury", "walkin", "waiting", false],
    ["Venkata Rao", "9885678901", "Hip pain, elderly", "website", "waiting", false],
    ["Kavya Reddy", "9963789012", "Neck stiffness", "whatsapp", "reserved", false],
    ["Ganesh Babu", "9848890123", "Cast removal", "walkin", "reserved", false],
    ["Sita Mahalakshmi", "9701901234", "Rheumatoid arthritis review", "website", "reserved", false],
  ];
  const times = ["09:30", "09:50", "10:05", "10:20", "10:35", "10:50", "11:10", "11:30", "11:50", "12:10"];
  return rows.map((r, i) => ({
    id: rid(), token: i + 1, name: r[0], phone: r[1], reason: r[2], date: today,
    time: times[i], status: r[4], source: r[3], fee, paid: r[5], createdAt: Date.now() - (10 - i) * 6e5,
  }));
}

// ── no-show policy: a slot nobody was marked into by day's end auto-moves to
// the next working day, so patients never lose their place just for missing
// the exact date (clinic policy — announced on the booking page + WhatsApp).
const carryOverStatuses: ApptStatus[] = ["reserved", "confirmed", "waiting"];

function nextWorkingDayAfter(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  for (let i = 0; i < 30; i++) {
    d.setDate(d.getDate() + 1);
    if (windowsFor(d).length > 0) return ymd(d);
  }
  return ymd(d);
}

function rescheduleNoShows(all: Appt[]): Appt[] {
  const today = ymd(new Date());
  const stale = all.filter((a) => a.date < today && carryOverStatuses.includes(a.status));
  if (!stale.length) return all;

  const result = all.filter((a) => !(a.date < today && carryOverStatuses.includes(a.status)));
  for (const a of [...stale].sort((x, y) => x.createdAt - y.createdAt)) {
    let newDate = a.date;
    do { newDate = nextWorkingDayAfter(newDate); } while (newDate < today);
    const token = (result.filter((x) => x.date === newDate).reduce((m, x) => Math.max(m, x.token), 0) || 0) + 1;
    result.push({ ...a, date: newDate, status: "reserved", token });
  }
  return result;
}

// ── low-level persistence + subscription (for useSyncExternalStore) ─────────
let cache: Appt[] | null = null;
const listeners = new Set<() => void>();

function read(): Appt[] {
  if (cache) return cache;
  if (typeof window === "undefined") return [];
  let loaded: Appt[];
  try {
    const raw = localStorage.getItem(KEY);
    loaded = raw ? (JSON.parse(raw) as Appt[]) : seed();
  } catch {
    loaded = seed();
  }
  cache = rescheduleNoShows(loaded);
  try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch {}
  return cache;
}
function write(next: Appt[]) {
  cache = next;
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch {}
  listeners.forEach((l) => l());
}
function subscribe(l: () => void) { listeners.add(l); return () => listeners.delete(l); }

// ── public actions ──────────────────────────────────────────────────────────
export function addWalkIn(input: { name: string; phone: string; reason: string; source?: Source }) {
  const all = read();
  const today = ymd(new Date());
  const todays = all.filter((a) => a.date === today);
  const token = (todays.reduce((m, a) => Math.max(m, a.token), 0) || 0) + 1;
  const appt: Appt = {
    id: rid(), token, name: input.name.trim(), phone: input.phone.trim(),
    reason: input.reason.trim() || "Consultation", date: today,
    time: new Date().toTimeString().slice(0, 5), status: "waiting",
    source: input.source ?? "walkin", fee: clinic.consultationFee, paid: false, createdAt: Date.now(),
  };
  write([...all, appt]);
  return appt;
}
// A patient booking a specific date + time from the website (or WhatsApp).
export function addBooking(input: { name: string; phone: string; reason: string; date: string; time: string; source?: Source }): Appt {
  const all = read();
  const dayAppts = all.filter((a) => a.date === input.date);
  const token = (dayAppts.reduce((m, a) => Math.max(m, a.token), 0) || 0) + 1;
  const appt: Appt = {
    id: rid(), token, name: input.name.trim(), phone: input.phone.trim(),
    reason: input.reason.trim() || "Consultation", date: input.date, time: input.time,
    status: "reserved", source: input.source ?? "website", fee: clinic.consultationFee,
    paid: false, createdAt: Date.now(),
  };
  write([...all, appt]);
  return appt;
}
// Times already taken on a date (so the slot picker can hide them).
export function takenSlots(date: string): string[] {
  return read().filter((a) => a.date === date && a.status !== "cancelled").map((a) => a.time);
}
export function setStatus(id: string, status: ApptStatus) {
  write(read().map((a) => (a.id === id ? { ...a, status, paid: status === "done" ? true : a.paid } : a)));
}
export function togglePaid(id: string) {
  write(read().map((a) => (a.id === id ? { ...a, paid: !a.paid } : a)));
}
export function resetDemo() { if (typeof window !== "undefined") localStorage.removeItem(KEY); cache = null; write(read()); }

// ── react hook ──────────────────────────────────────────────────────────────
const EMPTY: Appt[] = []; // stable ref for the server snapshot
export function useAppts(): Appt[] {
  return useSyncExternalStore(subscribe, read, () => EMPTY);
}

// derived
export function todaysAppts(all: Appt[]) {
  const today = ymd(new Date());
  return all.filter((a) => a.date === today).sort((a, b) => a.token - b.token);
}
export const activeStatuses: ApptStatus[] = ["reserved", "confirmed", "waiting", "consulting"];

// avoids SSR/CSR flash: only render store-driven UI after mount
const emptySubscribe = () => () => {};
export function useMounted() {
  return useSyncExternalStore(emptySubscribe, () => true, () => false);
}

// ── schedule + availability override (edited in admin, read by every surface) ─
const SKEY = "roc.schedule.v1";
type Saved = { weekly: WeeklyHours; exceptions: Record<string, Exception>; override: Override | null };

export function loadSchedule(): Saved {
  if (typeof window !== "undefined") {
    try {
      const raw = localStorage.getItem(SKEY);
      if (raw) { const s = JSON.parse(raw); return { weekly: s.weekly, exceptions: s.exceptions ?? {}, override: s.override ?? null }; }
    } catch {}
  }
  return { weekly: { ...weeklyHours }, exceptions: { ...exceptions }, override: null };
}
let scheduleTick = 0;
export function saveSchedule(weekly: WeeklyHours, ex: Record<string, Exception>, override: Override | null = null) {
  try { localStorage.setItem(SKEY, JSON.stringify({ weekly, exceptions: ex, override })); } catch {}
  applySchedule(weekly, ex);
  setOverride(override);
  scheduleTick++;
  listeners.forEach((l) => l());
}
// Subscribe to schedule/override changes (appts snapshot doesn't change on a
// schedule edit, so components that show availability need this to re-render).
export function useScheduleTick() {
  return useSyncExternalStore(subscribe, () => scheduleTick, () => 0);
}
// Call on client mount so statusAt()/slotsFor() reflect the saved schedule.
export function hydrateSchedule() {
  const s = loadSchedule();
  applySchedule(s.weekly, s.exceptions);
  setOverride(s.override);
}
// Front-desk toggle: force the doctor in / away for today, or follow the schedule.
export function setAvailabilityOverride(mode: "auto" | "in" | "out") {
  const s = loadSchedule();
  const override = mode === "auto" ? null : { date: ymd(new Date()), mode };
  saveSchedule(s.weekly, s.exceptions, override);
}
export function getOverrideMode(): "auto" | "in" | "out" {
  const ov = overrideRef.current;
  return ov && ov.date === ymd(new Date()) ? ov.mode : "auto";
}
