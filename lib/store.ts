"use client";
// ─────────────────────────────────────────────────────────────────────────────
// Mock data store (localStorage-backed) so the whole product runs zero-config.
// In production this is Supabase; every function here maps 1:1 to a table.
// ─────────────────────────────────────────────────────────────────────────────
import { useEffect, useState, useSyncExternalStore } from "react";
import { clinic } from "@/clinic.config";
import {
  ymd, weeklyHours, exceptions, applySchedule,
  type WeeklyHours, type Exception,
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

// ── low-level persistence + subscription (for useSyncExternalStore) ─────────
let cache: Appt[] | null = null;
const listeners = new Set<() => void>();

function read(): Appt[] {
  if (cache) return cache;
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(KEY);
    cache = raw ? (JSON.parse(raw) as Appt[]) : seed();
  } catch {
    cache = seed();
  }
  if (!localStorage.getItem(KEY)) localStorage.setItem(KEY, JSON.stringify(cache));
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
export function useMounted() {
  const [m, setM] = useState(false);
  useEffect(() => setM(true), []);
  return m;
}

// ── schedule override (edited in the admin, read by every surface) ───────────
const SKEY = "roc.schedule.v1";
export function loadSchedule(): { weekly: WeeklyHours; exceptions: Record<string, Exception> } {
  if (typeof window !== "undefined") {
    try {
      const raw = localStorage.getItem(SKEY);
      if (raw) return JSON.parse(raw);
    } catch {}
  }
  return { weekly: { ...weeklyHours }, exceptions: { ...exceptions } };
}
export function saveSchedule(weekly: WeeklyHours, ex: Record<string, Exception>) {
  try { localStorage.setItem(SKEY, JSON.stringify({ weekly, exceptions: ex })); } catch {}
  applySchedule(weekly, ex);
  listeners.forEach((l) => l());
}
// Call on client mount so statusAt()/slotsFor() reflect the saved schedule.
export function hydrateSchedule() {
  const s = loadSchedule();
  applySchedule(s.weekly, s.exceptions);
}
