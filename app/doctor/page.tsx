"use client";

import { useMemo, useState, useEffect, useCallback } from "react";
import Link from "next/link";
import {
  Calendar as CalendarIcon, Users, ArrowLeft, LogOut, RotateCcw,
  ChevronLeft, ChevronRight, Globe, MessageCircle, Footprints,
  Activity, Check, X, Clock, UserCheck, AlertCircle, Search,
  ChevronDown, ChevronUp, BarChart3, TrendingUp, IndianRupee,
} from "lucide-react";
import { clinic } from "@/clinic.config";
import { useMounted, apptsForDate, resetDemo, setNotes, ageGenderLabel, type Appt, type ApptStatus, type Source } from "@/lib/store";
import { ymd, fmt, nowIST } from "@/lib/schedule";
import { hasSupabase, supabaseBrowser } from "@/lib/supabase";
import { useAdminAppts, dbSetNotes } from "@/lib/admin-db";
import { downloadCsv } from "@/lib/csv";

// Only relevant in DB mode.
async function signOutStaff() {
  await supabaseBrowser().auth.signOut();
  window.location.href = "/login";
}

async function saveNote(id: string, notes: string) {
  if (hasSupabase()) await dbSetNotes(id, notes);
  else setNotes(id, notes);
}

type Tab = "today" | "calendar" | "patients" | "practice";
const money = (n: number) => `${clinic.currency}${n.toLocaleString("en-IN")}`;
const dateLabel = (date: string) => {
  const d = new Date(date + "T00:00:00");
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) });
};
const sourceMeta: Record<Source, { label: string; icon: typeof Globe }> = {
  website: { label: "Website", icon: Globe },
  whatsapp: { label: "WhatsApp", icon: MessageCircle },
  walkin: { label: "Walk-in", icon: Footprints },
};
const statusMeta: Record<ApptStatus, { label: string; cls: string }> = {
  reserved: { label: "Reserved", cls: "bg-brand-tint text-brand" },
  confirmed: { label: "Confirmed", cls: "bg-brand-tint text-brand" },
  waiting: { label: "Waiting", cls: "bg-accent-tint text-accent" },
  consulting: { label: "In consult", cls: "bg-in/15 text-in" },
  done: { label: "Done", cls: "bg-muted/15 text-muted" },
  cancelled: { label: "Cancelled", cls: "bg-out/10 text-out line-through" },
  payment_pending: { label: "Awaiting payment", cls: "bg-accent-tint text-accent" },
};

const NAV: { id: Tab; label: string; icon: typeof Users }[] = [
  { id: "today", label: "Today", icon: Activity },
  { id: "calendar", label: "Calendar", icon: CalendarIcon },
  { id: "patients", label: "Patients", icon: Users },
  { id: "practice", label: "My Practice", icon: BarChart3 },
];

// ── ortho note snippets ──────────────────────────────────────────────────────
const ORTHO_SNIPPETS = [
  "ROM improved", "Swelling reduced", "Cast removed", "Advised physio",
  "X-ray reviewed", "Healing well", "Follow-up needed", "Pain reduced",
  "Medication continued", "Fracture stable",
];

// ── action error broadcast (same pattern as admin) ───────────────────────────
type ErrorListener = (msg: string) => void;
const actionErrorListeners = new Set<ErrorListener>();
function notifyActionError(msg: string) {
  for (const l of actionErrorListeners) l(msg);
}
function useActionErrorBanner(): string | null {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    actionErrorListeners.add(setMsg);
    return () => { actionErrorListeners.delete(setMsg); };
  }, []);
  useEffect(() => { if (msg) { const t = setTimeout(() => setMsg(null), 5000); return () => clearTimeout(t); } }, [msg]);
  return msg;
}

// ── patient history helpers ──────────────────────────────────────────────────
type PatientSummary = {
  name: string;
  phone: string;
  patientCode: string | null;
  age: number;
  gender: "M" | "F" | null;
  visits: Appt[];
  visitCount: number;
  lastVisitDate: string | null;
  lastNote: string | null;
};

function buildPatientMap(appts: Appt[]): Map<string, PatientSummary> {
  const m = new Map<string, PatientSummary>();
  const sorted = [...appts].sort((a, b) => b.createdAt - a.createdAt);
  for (const a of sorted) {
    const k = a.phone ? `p:${a.phone}` : `a:${a.id}`;
    const cur = m.get(k);
    if (cur) {
      cur.visits.push(a);
      cur.visitCount++;
    } else {
      m.set(k, {
        name: a.name,
        phone: a.phone,
        patientCode: a.patientCode,
        age: a.age,
        gender: a.gender,
        visits: [a],
        visitCount: 1,
        lastVisitDate: null,
        lastNote: null,
      });
    }
  }
  // Compute lastVisitDate and lastNote from completed visits
  for (const p of m.values()) {
    const completed = p.visits.filter((v) => v.status === "done").sort((a, b) => (b.date > a.date ? 1 : -1));
    if (completed.length) {
      p.lastVisitDate = completed[0].date;
      p.lastNote = completed.find((v) => v.notes)?.notes ?? null;
    }
  }
  return m;
}

function getPatientHistory(appts: Appt[], phone: string): Appt[] {
  if (!phone) return [];
  return appts
    .filter((a) => a.phone === phone && a.status !== "payment_pending")
    .sort((a, b) => (b.date > a.date ? 1 : b.date < a.date ? -1 : b.time > a.time ? 1 : -1));
}

function visitLabel(appts: Appt[], phone: string, currentDate: string): string {
  if (!phone) return "New patient";
  const past = appts.filter((a) => a.phone === phone && a.date < currentDate && a.status !== "payment_pending" && a.status !== "cancelled");
  if (past.length === 0) return "New patient";
  const last = past.sort((a, b) => (b.date > a.date ? 1 : -1))[0];
  const daysSince = Math.round((new Date(currentDate).getTime() - new Date(last.date).getTime()) / 86400000);
  const count = past.length + 1;
  const suffix = count === 2 ? "2nd" : count === 3 ? "3rd" : `${count}th`;
  return `${suffix} visit · last ${daysSince <= 1 ? "yesterday" : daysSince < 7 ? `${daysSince}d ago` : daysSince < 30 ? `${Math.round(daysSince / 7)}w ago` : dateLabel(last.date)}`;
}

function lastNoteForPatient(appts: Appt[], phone: string, currentDate: string): string | null {
  if (!phone) return null;
  const past = appts.filter((a) => a.phone === phone && a.date < currentDate && a.notes && a.status !== "payment_pending");
  const sorted = past.sort((a, b) => (b.date > a.date ? 1 : -1));
  return sorted[0]?.notes ?? null;
}

// ── main component ───────────────────────────────────────────────────────────
export default function Doctor() {
  const [tab, setTab] = useState<Tab>("today");
  const mounted = useMounted();
  const [appts, patchAppt, apptsLoadError] = useAdminAppts();
  const actionError = useActionErrorBanner();
  const [detailPhone, setDetailPhone] = useState<string | null>(null);

  const openDetail = useCallback((phone: string) => { if (phone) setDetailPhone(phone); }, []);
  const closeDetail = useCallback(() => setDetailPhone(null), []);

  return (
    <div className="min-h-screen bg-bone text-ink flex">
      {/* Sidebar */}
      <aside className="hidden md:flex w-60 shrink-0 flex-col border-r border-line bg-paper">
        <div className="px-5 py-5 border-b border-line">
          <div className="font-display text-lg leading-tight">Ramachandra<span className="text-brand"> Ortho</span></div>
          <div className="text-xs text-muted">Doctor</div>
        </div>
        <nav className="flex-1 p-3 space-y-1">
          {NAV.map((n) => (
            <button key={n.id} onClick={() => setTab(n.id)}
              className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition ${tab === n.id ? "bg-brand text-white" : "text-muted hover:bg-brand-tint/60 hover:text-ink"}`}>
              <n.icon className="h-[18px] w-[18px]" /> {n.label}
            </button>
          ))}
        </nav>
        <div className="p-3 border-t border-line space-y-1">
          <Link href="/" className="flex items-center gap-2 rounded-xl px-3 py-2 text-sm text-muted hover:text-ink"><ArrowLeft className="h-4 w-4" /> View site</Link>
          {!hasSupabase() && (
            <button onClick={resetDemo} className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-xs text-muted hover:text-out"><RotateCcw className="h-3.5 w-3.5" /> Reset demo data</button>
          )}
          {hasSupabase() && (
            <button onClick={signOutStaff} className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm text-muted hover:text-out"><LogOut className="h-4 w-4" /> Sign out</button>
          )}
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 min-w-0">
        {/* Topbar */}
        <div className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-line bg-bone/85 px-4 md:px-8 h-16 backdrop-blur-md">
          <div className="flex items-center gap-3">
            <div className="md:hidden flex gap-1">
              {NAV.map((n) => (
                <button key={n.id} onClick={() => setTab(n.id)} className={`rounded-lg p-2 ${tab === n.id ? "bg-brand text-white" : "text-muted"}`}><n.icon className="h-4 w-4" /></button>
              ))}
            </div>
            <h1 className="font-display text-xl hidden sm:block">{NAV.find((n) => n.id === tab)?.label}</h1>
          </div>
          <div className="flex items-center gap-2">
            {hasSupabase() && (
              <button onClick={signOutStaff} className="md:hidden rounded-lg p-2 text-muted hover:text-out" aria-label="Sign out"><LogOut className="h-4 w-4" /></button>
            )}
          </div>
        </div>

        {(apptsLoadError || actionError) && (
          <div className="border-b border-out/20 bg-out/10 px-4 md:px-8 py-2 text-sm text-out">
            {actionError ?? "Couldn’t load appointments. Refresh to retry."}
          </div>
        )}

        <div className="p-4 md:p-8">
          {!mounted ? (
            <div className="text-sm text-muted">Loading...</div>
          ) : tab === "today" ? (
            <TodayTab appts={appts} patchAppt={patchAppt} openDetail={openDetail} />
          ) : tab === "calendar" ? (
            <DoctorCalendar appts={appts} openDetail={openDetail} />
          ) : tab === "patients" ? (
            <DoctorPatients appts={appts} openDetail={openDetail} />
          ) : (
            <MyPractice appts={appts} />
          )}
        </div>
      </main>

      {/* Patient Detail Panel */}
      {detailPhone && <PatientDetailPanel phone={detailPhone} appts={appts} onClose={closeDetail} />}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════════
   TODAY TAB — the doctor's daily command center
   ══════════════════════════════════════════════════════════════════════════════ */

function TodayTab({ appts, patchAppt, openDetail }: { appts: Appt[]; patchAppt: (id: string, patch: Partial<Appt>) => void; openDetail: (phone: string) => void }) {
  const now = nowIST();
  // Stable string deps for useMemo — memoized so the React compiler can prove stability
  const todayStr = useMemo(() => ymd(nowIST()), []); // eslint-disable-line react-hooks/exhaustive-deps
  const yesterdayStr = useMemo(() => { const d = nowIST(); d.setDate(d.getDate() - 1); return ymd(d); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const todayAppts = useMemo(
    () => apptsForDate(appts, todayStr).filter((a) => a.status !== "payment_pending" && a.status !== "cancelled"),
    [appts, todayStr]
  );

  // First-ever appointment date per phone (for new/returning logic)
  const firstApptByPhone = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of appts) {
      if (!a.phone || a.status === "payment_pending" || a.status === "cancelled") continue;
      const cur = m.get(a.phone);
      if (!cur || a.date < cur) m.set(a.phone, a.date);
    }
    return m;
  }, [appts]);

  const newCount = todayAppts.filter((a) => !a.phone || firstApptByPhone.get(a.phone) === todayStr).length;
  const returningCount = todayAppts.length - newCount;
  const sorted = [...todayAppts].sort((a, b) => a.token - b.token);
  const times = sorted.map((a) => a.time).sort();
  const firstTime = times[0];
  const lastTime = times[times.length - 1];

  // Yesterday stats
  const yesterdayAppts = useMemo(
    () => appts.filter((a) => a.date === yesterdayStr && a.status !== "payment_pending" && a.status !== "cancelled"),
    [appts, yesterdayStr]
  );
  const yesterdayCollected = yesterdayAppts.filter((a) => a.paid && !a.refundedAt).reduce((s, a) => s + a.fee, 0);

  // Mark done handler
  const markDone = (id: string) => {
    patchAppt(id, { status: "done" });
    if (hasSupabase()) {
      fetch("/api/appointments/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, status: "done" }),
      })
        .then((res) => { if (!res.ok) throw new Error(String(res.status)); })
        .catch((err) => {
          console.error("doctor: could not mark done", err);
          patchAppt(id, { status: "consulting" });
          notifyActionError("Could not mark this patient as done. Please try again.");
        });
    }
  };

  // Greeting
  const hour = now.getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  // Extract just the short name: "Dr. Ramachandrudu (Rajesh)" → "Dr. Rajesh"
  const match = clinic.doctor.name.match(/\((\w+)\)/);
  const shortName = match ? `Dr. ${match[1]}` : clinic.doctor.name.split(" ").slice(0, 2).join(" ");

  return (
    <div className="max-w-3xl space-y-6">
      {/* Morning Briefing */}
      <div className="rounded-2xl border border-brand/20 bg-gradient-to-br from-brand-tint to-paper p-5 sm:p-6">
        <h2 className="font-display text-xl sm:text-2xl text-ink">{greeting}, {shortName}</h2>
        {todayAppts.length > 0 ? (
          <>
            <p className="mt-2 text-sm text-muted">
              <span className="font-semibold text-ink">{todayAppts.length} patient{todayAppts.length !== 1 ? "s" : ""}</span> today
              {newCount > 0 && <> ({newCount} new, {returningCount} returning)</>}
              {firstTime && <> · {fmt(firstTime)} to {fmt(lastTime!)}</>}
            </p>
            {yesterdayAppts.length > 0 && (
              <p className="mt-1 text-xs text-muted">
                Yesterday: {yesterdayAppts.length} patient{yesterdayAppts.length !== 1 ? "s" : ""}, {money(yesterdayCollected)} collected
              </p>
            )}
          </>
        ) : (
          <p className="mt-2 text-sm text-muted">No appointments scheduled today. Enjoy your day off, Doctor.</p>
        )}
      </div>

      {/* Follow-up Alerts */}
      <FollowUpAlerts appts={appts} todayStr={todayStr} openDetail={openDetail} />

      {/* Live Queue */}
      {sorted.length > 0 ? (
        <div className="rounded-2xl border border-line bg-paper">
          <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
            <span className="font-semibold">Today&apos;s queue</span>
            <span className="text-xs text-muted">{sorted.filter((a) => a.status === "done").length}/{sorted.length} done</span>
          </div>
          <ul className="divide-y divide-line">
            {sorted.map((a) => (
              <QueueRow key={a.id} a={a} appts={appts} todayStr={todayStr} markDone={markDone} openDetail={openDetail} />
            ))}
          </ul>
        </div>
      ) : (
        todayAppts.length === 0 && (
          <div className="rounded-2xl border border-line bg-paper px-5 py-10 text-center text-sm text-muted">
            No patients in the queue yet.
          </div>
        )
      )}
    </div>
  );
}

/* ── queue row ────────────────────────────────────────────────────────────── */
function QueueRow({ a, appts, todayStr, markDone, openDetail }: {
  a: Appt; appts: Appt[]; todayStr: string;
  markDone: (id: string) => void; openDetail: (phone: string) => void;
}) {
  const [notes, setLocalNotes] = useState(a.notes ?? "");
  const [saved, setSaved] = useState(true);
  const [showNotes, setShowNotes] = useState(false);
  const S = sourceMeta[a.source];
  const visit = visitLabel(appts, a.phone, todayStr);
  const prevNote = lastNoteForPatient(appts, a.phone, todayStr);
  const isConsulting = a.status === "consulting";
  const isDone = a.status === "done";

  const commit = () => {
    if (notes === (a.notes ?? "")) return;
    saveNote(a.id, notes).then(() => setSaved(true)).catch((err) => console.error("doctor: could not save note", err));
  };

  const addSnippet = (s: string) => {
    setLocalNotes((prev) => {
      const trimmed = prev.trim();
      return trimmed ? `${trimmed}, ${s}` : s;
    });
    setSaved(false);
  };

  return (
    <li className={`px-4 py-3 sm:px-5 sm:py-4 transition ${isConsulting ? "bg-in/[0.04]" : ""}`}>
      <div className="flex items-start gap-2.5 sm:gap-3">
        {/* Token */}
        <div className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl font-mono text-sm font-semibold sm:h-10 sm:w-10 ${
          isDone ? "bg-muted/10 text-muted" : isConsulting ? "bg-in text-white" : "bg-brand text-white"
        }`}>{a.token}</div>

        {/* Info */}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
            <button onClick={() => openDetail(a.phone)} className="truncate font-medium hover:text-brand hover:underline">{a.name}</button>
            {a.patientCode && <span className="font-mono text-[11px] text-muted">{a.patientCode}</span>}
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${statusMeta[a.status].cls}`}>{statusMeta[a.status].label}</span>
          </div>
          <div className="flex flex-wrap items-center gap-1 text-xs text-muted mt-0.5">
            <span>{fmt(a.time)}</span>
            <span className="text-line">·</span>
            <span className="inline-flex items-center gap-0.5"><S.icon className="h-3 w-3" />{S.label}</span>
            {ageGenderLabel(a) && <><span className="text-line">·</span><span>{ageGenderLabel(a)}</span></>}
          </div>
          {/* Visit history + last note */}
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${
              visit === "New patient" ? "bg-accent-tint text-accent" : "bg-brand-tint text-brand"
            }`}>
              <UserCheck className="h-2.5 w-2.5" />{visit}
            </span>
          </div>
          {prevNote && !showNotes && (
            <p className="mt-1 truncate text-[11px] italic text-muted/70">prev: {prevNote}</p>
          )}
        </div>

        {/* Actions */}
        <div className="flex shrink-0 items-center gap-1.5">
          <button onClick={() => setShowNotes(!showNotes)} title={showNotes ? "Hide notes" : "Write note"}
            className={`rounded-lg border p-2 text-sm transition ${showNotes ? "border-brand bg-brand-tint text-brand" : "border-line text-muted hover:text-brand hover:border-brand/40"}`}>
            {showNotes ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </button>
          {isConsulting && (
            <button onClick={() => markDone(a.id)} title="Mark done"
              className="rounded-lg border border-in/30 bg-in/10 p-2 text-in hover:bg-in hover:text-white transition">
              <Check className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {/* Notes area */}
      {showNotes && (
        <div className="mt-3 ml-11 sm:ml-[52px]">
          <div className="mb-2 flex flex-wrap gap-1">
            {ORTHO_SNIPPETS.map((s) => (
              <button key={s} onClick={() => addSnippet(s)}
                className="rounded-full border border-line bg-bone px-2 py-0.5 text-[10px] text-muted hover:border-brand/40 hover:text-brand transition">
                {s}
              </button>
            ))}
          </div>
          <textarea
            value={notes}
            onChange={(e) => { setLocalNotes(e.target.value); setSaved(false); }}
            onBlur={commit}
            placeholder="Clinical note for this visit..."
            rows={3}
            className="w-full resize-none rounded-lg border border-line bg-white px-3 py-2 text-sm outline-none focus:border-brand"
          />
          {!saved && <div className="mt-0.5 text-[10px] text-muted">Saving...</div>}
        </div>
      )}
    </li>
  );
}

/* ── follow-up alerts ────────────────────────────────────────────────────── */
function FollowUpAlerts({ appts, todayStr, openDetail }: { appts: Appt[]; todayStr: string; openDetail: (phone: string) => void }) {
  const [open, setOpen] = useState(true);

  const alerts = useMemo(() => {
    // Group by phone, find last completed visit, check if they have a future appointment
    const byPhone = new Map<string, { name: string; code: string | null; phone: string; lastDone: Appt; hasFuture: boolean }>();
    const sorted = [...appts].sort((a, b) => (b.date > a.date ? 1 : -1));

    for (const a of sorted) {
      if (!a.phone || a.status === "payment_pending") continue;
      const key = a.phone;
      const cur = byPhone.get(key);

      if (!cur) {
        byPhone.set(key, {
          name: a.name,
          code: a.patientCode,
          phone: a.phone,
          lastDone: a.status === "done" ? a : { ...a, date: "" } as Appt,
          hasFuture: a.date >= todayStr && a.status !== "cancelled" && a.status !== "done",
        });
      } else {
        if (a.status === "done" && (!cur.lastDone.date || a.date > cur.lastDone.date)) {
          cur.lastDone = a;
        }
        if (a.date >= todayStr && a.status !== "cancelled" && a.status !== "done") {
          cur.hasFuture = true;
        }
      }
    }

    const results: { name: string; code: string | null; phone: string; daysSince: number; lastNote: string | null }[] = [];
    const todayMs = new Date(todayStr).getTime();

    for (const p of byPhone.values()) {
      if (!p.lastDone.date || p.hasFuture) continue;
      const daysSince = Math.round((todayMs - new Date(p.lastDone.date).getTime()) / 86400000);
      if (daysSince >= 7 && daysSince <= 30) {
        results.push({
          name: p.name,
          code: p.code,
          phone: p.phone,
          daysSince,
          lastNote: p.lastDone.notes,
        });
      }
    }

    return results.sort((a, b) => a.daysSince - b.daysSince);
  }, [appts, todayStr]);

  if (alerts.length === 0) return null;

  const dueThisWeek = alerts.filter((a) => a.daysSince <= 14);
  const checkIn = alerts.filter((a) => a.daysSince > 14);

  return (
    <div className="rounded-2xl border border-accent/20 bg-accent-tint/30">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center justify-between px-5 py-3.5">
        <span className="flex items-center gap-2 text-sm font-semibold text-accent">
          <AlertCircle className="h-4 w-4" />
          {alerts.length} patient{alerts.length !== 1 ? "s" : ""} may need a follow-up
        </span>
        {open ? <ChevronUp className="h-4 w-4 text-muted" /> : <ChevronDown className="h-4 w-4 text-muted" />}
      </button>
      {open && (
        <div className="border-t border-accent/10 px-5 py-3 space-y-3">
          {dueThisWeek.length > 0 && (
            <div>
              <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-accent/70">Due this week</div>
              {dueThisWeek.map((a) => (
                <FollowUpRow key={a.phone} a={a} openDetail={openDetail} />
              ))}
            </div>
          )}
          {checkIn.length > 0 && (
            <div>
              <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted">May need check-in</div>
              {checkIn.map((a) => (
                <FollowUpRow key={a.phone} a={a} openDetail={openDetail} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function FollowUpRow({ a, openDetail }: { a: { name: string; code: string | null; phone: string; daysSince: number; lastNote: string | null }; openDetail: (phone: string) => void }) {
  return (
    <div className="flex items-center gap-2 py-1.5">
      <button onClick={() => openDetail(a.phone)} className="min-w-0 flex-1 truncate text-sm font-medium hover:text-brand hover:underline text-left">{a.name}</button>
      {a.code && <span className="font-mono text-[10px] text-muted">{a.code}</span>}
      <span className="shrink-0 rounded-full bg-accent-tint px-2 py-0.5 text-[10px] font-medium text-accent">{a.daysSince}d ago</span>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════════
   PATIENT DETAIL PANEL (overlay)
   ══════════════════════════════════════════════════════════════════════════════ */

function PatientDetailPanel({ phone, appts, onClose }: { phone: string; appts: Appt[]; onClose: () => void }) {
  const history = useMemo(() => getPatientHistory(appts, phone), [appts, phone]);
  if (history.length === 0) { onClose(); return null; }

  const latest = history[0];
  const completed = history.filter((a) => a.status === "done");
  const firstVisit = [...history].sort((a, b) => (a.date > b.date ? 1 : -1))[0];

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-40 bg-ink/30 backdrop-blur-sm" onClick={onClose} />
      {/* Panel */}
      <div className="fixed inset-y-0 right-0 z-50 w-full max-w-md overflow-y-auto bg-paper shadow-xl border-l border-line">
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-line bg-paper px-5 py-4">
          <div>
            <h2 className="font-display text-lg">{latest.name}</h2>
            <div className="flex items-center gap-2 text-xs text-muted">
              {latest.patientCode && <span className="font-mono">{latest.patientCode}</span>}
              {latest.phone && <span>{latest.phone}</span>}
              {ageGenderLabel(latest) && <span>{ageGenderLabel(latest)}</span>}
            </div>
          </div>
          <button onClick={onClose} className="rounded-lg border border-line p-2 text-muted hover:text-ink"><X className="h-4 w-4" /></button>
        </div>

        {/* Summary */}
        <div className="grid grid-cols-3 gap-3 px-5 py-4 border-b border-line">
          <div className="text-center">
            <div className="font-display text-2xl text-brand">{history.length}</div>
            <div className="text-[11px] text-muted">Total visits</div>
          </div>
          <div className="text-center">
            <div className="font-display text-2xl text-ink">{completed.length}</div>
            <div className="text-[11px] text-muted">Completed</div>
          </div>
          <div className="text-center">
            <div className="text-sm font-medium text-ink">{dateLabel(firstVisit.date)}</div>
            <div className="text-[11px] text-muted">First visit</div>
          </div>
        </div>

        {/* Visit Timeline */}
        <div className="px-5 py-4">
          <h3 className="mb-3 text-sm font-semibold">Visit history</h3>
          <div className="space-y-4">
            {history.map((a) => {
              const S = sourceMeta[a.source];
              return (
                <div key={a.id} className="relative pl-5 before:absolute before:left-[3px] before:top-2 before:h-2 before:w-2 before:rounded-full before:bg-brand after:absolute after:left-[7px] after:top-4 after:bottom-0 after:w-px after:bg-line last:after:hidden">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="font-medium">{dateLabel(a.date)}</span>
                    <span className="text-muted">{fmt(a.time)}</span>
                    <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${statusMeta[a.status].cls}`}>{statusMeta[a.status].label}</span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-xs text-muted">
                    <span className="inline-flex items-center gap-0.5"><S.icon className="h-3 w-3" />{S.label}</span>
                    <span>Token #{a.token}</span>
                    {a.paid && <span className="text-in">{money(a.fee)} paid</span>}
                  </div>
                  {a.notes && (
                    <div className="mt-1.5 rounded-lg bg-bone px-3 py-2 text-xs text-ink leading-relaxed">
                      {a.notes}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}

/* ══════════════════════════════════════════════════════════════════════════════
   CALENDAR — month grid + day drill-down + clinical notes
   ══════════════════════════════════════════════════════════════════════════════ */

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function monthMatrix(year: number, month: number): (string | null)[] {
  const startWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: (string | null)[] = Array.from({ length: startWeekday }, () => null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(ymd(new Date(year, month, d)));
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

function DoctorCalendar({ appts, openDetail }: { appts: Appt[]; openDetail: (phone: string) => void }) {
  const today = nowIST();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());
  const [selected, setSelected] = useState(ymd(today));
  const todayStr = ymd(today);

  const countsByDate = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of appts) {
      if (a.status === "cancelled" || a.status === "payment_pending") continue;
      m.set(a.date, (m.get(a.date) ?? 0) + 1);
    }
    return m;
  }, [appts]);

  const cells = useMemo(() => monthMatrix(year, month), [year, month]);
  const shiftMonth = (n: number) => {
    const d = new Date(year, month + n, 1);
    setYear(d.getFullYear());
    setMonth(d.getMonth());
  };
  const jumpToday = () => {
    setYear(today.getFullYear());
    setMonth(today.getMonth());
    setSelected(todayStr);
  };
  const monthLabel = new Date(year, month, 1).toLocaleDateString("en-IN", { month: "long", year: "numeric" });
  const dayList = apptsForDate(appts, selected).filter((a) => a.status !== "payment_pending");

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-lg">{monthLabel}</h2>
        <div className="flex items-center gap-1.5">
          <button onClick={() => shiftMonth(-1)} title="Previous month" className="rounded-lg border border-line p-1.5 text-muted hover:bg-line/40 hover:text-ink"><ChevronLeft className="h-4 w-4" /></button>
          <button onClick={jumpToday} className="rounded-full bg-brand-tint px-2.5 py-1.5 text-xs font-semibold text-brand hover:bg-brand hover:text-white">Today</button>
          <button onClick={() => shiftMonth(1)} title="Next month" className="rounded-lg border border-line p-1.5 text-muted hover:bg-line/40 hover:text-ink"><ChevronRight className="h-4 w-4" /></button>
        </div>
      </div>

      <div className="rounded-2xl border border-line bg-paper p-3 sm:p-4">
        <div className="mb-1 grid grid-cols-7 gap-1 text-center text-[11px] font-medium text-muted">
          {DAY_LABELS.map((d) => <div key={d}>{d}</div>)}
        </div>
        <div className="grid grid-cols-7 gap-1">
          {cells.map((date, i) => {
            if (!date) return <div key={i} />;
            const n = countsByDate.get(date) ?? 0;
            const isToday = date === todayStr;
            const isSelected = date === selected;
            return (
              <button key={date} onClick={() => setSelected(date)}
                className={`aspect-square rounded-lg border p-1 text-left text-xs transition ${
                  isSelected ? "border-brand bg-brand text-white" : isToday ? "border-brand/50 bg-brand-tint/40" : "border-line bg-white hover:border-brand/40"
                }`}>
                <div className="font-medium">{Number(date.slice(-2))}</div>
                {n > 0 && <div className={`mt-1 text-[10px] ${isSelected ? "text-white/80" : "text-muted"}`}>{n} appt{n > 1 ? "s" : ""}</div>}
              </button>
            );
          })}
        </div>
      </div>

      <div className="rounded-2xl border border-line bg-paper">
        <div className="border-b border-line px-5 py-3.5 font-semibold">{dateLabel(selected)} · {dayList.length} appointment{dayList.length === 1 ? "" : "s"}</div>
        <ul className="divide-y divide-line">
          {dayList.map((a) => <CalendarDayRow key={a.id} a={a} openDetail={openDetail} />)}
          {dayList.length === 0 && <li className="px-5 py-8 text-center text-sm text-muted">No appointments.</li>}
        </ul>
      </div>
    </div>
  );
}

function CalendarDayRow({ a, openDetail }: { a: Appt; openDetail: (phone: string) => void }) {
  const [notes, setLocalNotes] = useState(a.notes ?? "");
  const [saved, setSaved] = useState(true);
  const S = sourceMeta[a.source];

  const commit = () => {
    if (notes === (a.notes ?? "")) return;
    saveNote(a.id, notes).then(() => setSaved(true)).catch((err) => console.error("doctor: could not save note", err));
  };

  const addSnippet = (s: string) => {
    setLocalNotes((prev) => {
      const trimmed = prev.trim();
      return trimmed ? `${trimmed}, ${s}` : s;
    });
    setSaved(false);
  };

  return (
    <li className="px-3.5 py-3 sm:px-5 sm:py-3.5">
      <div className="flex items-center gap-2 sm:gap-3">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand-tint font-mono text-xs font-semibold text-brand">{a.token}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={() => openDetail(a.phone)} className="font-medium hover:text-brand hover:underline">{a.name}</button>
            {a.patientCode && <span className="font-mono text-[11px] text-muted">{a.patientCode}</span>}
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${statusMeta[a.status].cls}`}>{statusMeta[a.status].label}</span>
          </div>
          <div className="flex items-center gap-1 text-xs text-muted">
            <span>{fmt(a.time)}</span> · <span className="inline-flex items-center gap-1"><S.icon className="h-3 w-3" />{S.label}</span>{ageGenderLabel(a) && <span> · {ageGenderLabel(a)}</span>}
            {a.phone && <span> · {a.phone}</span>}
          </div>
        </div>
      </div>
      {/* Snippets + Notes */}
      <div className="mt-2 ml-10 sm:ml-11">
        <div className="mb-1.5 flex flex-wrap gap-1">
          {ORTHO_SNIPPETS.slice(0, 6).map((s) => (
            <button key={s} onClick={() => addSnippet(s)}
              className="rounded-full border border-line bg-bone px-2 py-0.5 text-[10px] text-muted hover:border-brand/40 hover:text-brand transition">
              {s}
            </button>
          ))}
        </div>
        <textarea
          value={notes}
          onChange={(e) => { setLocalNotes(e.target.value); setSaved(false); }}
          onBlur={commit}
          placeholder="Clinical note for this visit..."
          rows={2}
          className="w-full resize-none rounded-lg border border-line bg-white px-3 py-2 text-sm outline-none focus:border-brand"
        />
        {!saved && <div className="mt-1 text-[11px] text-muted">Saving...</div>}
      </div>
    </li>
  );
}

/* ══════════════════════════════════════════════════════════════════════════════
   PATIENTS — search + list + click-through to detail
   ══════════════════════════════════════════════════════════════════════════════ */

function DoctorPatients({ appts, openDetail }: { appts: Appt[]; openDetail: (phone: string) => void }) {
  const [q, setQ] = useState("");
  const list = useMemo(() => {
    const by = new Map<string, { name: string; phone: string; visits: number; last: Appt }>();
    for (const a of [...appts].sort((x, y) => y.createdAt - x.createdAt)) {
      if (a.status === "payment_pending") continue;
      const k = a.phone ? `p:${a.phone}` : `a:${a.id}`;
      const cur = by.get(k);
      if (cur) cur.visits++;
      else by.set(k, { name: a.name, phone: a.phone, visits: 1, last: a });
    }
    return [...by.values()].filter((p) => (p.name + p.phone).toLowerCase().includes(q.toLowerCase()));
  }, [appts, q]);

  const exportCsv = () => {
    const rows: string[][] = [["Name", "Phone", "Age", "Gender", "Visits", "Last visit"]];
    for (const p of list) {
      rows.push([p.name, p.phone, p.last.age ? String(p.last.age) : "", p.last.gender ?? "", String(p.visits), p.last.date]);
    }
    downloadCsv(`patients-${ymd(new Date())}.csv`, rows);
  };

  return (
    <div className="max-w-3xl">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search patients..." className="w-full rounded-lg border border-line bg-white pl-9 pr-3 py-2 text-sm outline-none focus:border-brand" />
        </div>
        <button onClick={exportCsv} className="rounded-lg border border-line bg-white px-3.5 py-2 text-sm font-medium text-ink hover:bg-bone/60">Export CSV</button>
      </div>
      <div className="rounded-2xl border border-line bg-paper divide-y divide-line">
        {list.map((p) => (
          <button key={p.last.id} onClick={() => openDetail(p.phone)} className="flex w-full items-center gap-3 px-5 py-3 text-left hover:bg-bone/40 transition">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand-tint text-sm font-semibold text-brand">{p.name[0]}</span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate font-medium">{p.name}</span>
                {p.last.patientCode && <span className="font-mono text-[11px] text-muted">{p.last.patientCode}</span>}
              </div>
              <div className="text-xs text-muted">{p.phone || "no phone"}{ageGenderLabel(p.last) && ` · ${ageGenderLabel(p.last)}`}</div>
              {p.last.notes && <div className="truncate text-xs italic text-muted/70">note: {p.last.notes}</div>}
            </div>
            <span className="shrink-0 rounded-full bg-brand-tint px-2.5 py-1 text-xs font-medium text-brand">{p.visits} visit{p.visits > 1 ? "s" : ""}</span>
          </button>
        ))}
        {list.length === 0 && <div className="px-5 py-8 text-center text-sm text-muted">No patients.</div>}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════════
   MY PRACTICE — revenue + doctor-focused metrics
   ══════════════════════════════════════════════════════════════════════════════ */

type Range = "today" | "week" | "month" | "last30";
const RANGE_OPTS: { r: Range; label: string }[] = [
  { r: "today", label: "Today" },
  { r: "week", label: "This week" },
  { r: "month", label: "This month" },
  { r: "last30", label: "Last 30 days" },
];

function rangeBounds(range: Range): { start: string; end: string } {
  const today = nowIST();
  const end = ymd(today);
  if (range === "today") return { start: end, end };
  if (range === "week") {
    const d = new Date(today);
    d.setDate(d.getDate() - d.getDay());
    return { start: ymd(d), end };
  }
  if (range === "month") return { start: ymd(new Date(today.getFullYear(), today.getMonth(), 1)), end };
  const d = new Date(today);
  d.setDate(d.getDate() - 29);
  return { start: ymd(d), end };
}

function dateRangeList(start: string, end: string): string[] {
  const list: string[] = [];
  const d = new Date(start + "T00:00:00");
  const endDate = new Date(end + "T00:00:00");
  while (d <= endDate) {
    list.push(ymd(d));
    d.setDate(d.getDate() + 1);
  }
  return list;
}

function MyPractice({ appts }: { appts: Appt[] }) {
  const [range, setRange] = useState<Range>("month");
  const { start, end } = rangeBounds(range);
  const allActive = useMemo(
    () => appts.filter((a) => a.status !== "payment_pending" && a.status !== "cancelled"),
    [appts]
  );
  const inRange = useMemo(
    () => allActive.filter((a) => a.date >= start && a.date <= end),
    [allActive, start, end]
  );
  const collected = useMemo(() => inRange.filter((a) => a.paid && a.refundedAt == null), [inRange]);
  const total = collected.reduce((s, a) => s + a.fee, 0);
  const dateList = useMemo(() => dateRangeList(start, end), [start, end]);
  const avgPerDay = dateList.length ? total / dateList.length : 0;

  const byDate = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of collected) m.set(a.date, (m.get(a.date) ?? 0) + a.fee);
    return m;
  }, [collected]);
  const maxDay = Math.max(1, ...dateList.map((d) => byDate.get(d) ?? 0));

  const bySource = (["website", "whatsapp", "walkin"] as Source[]).map((s) => ({ s, n: inRange.filter((a) => a.source === s).length }));
  const maxSource = Math.max(1, ...bySource.map((b) => b.n));

  const firstApptByPhone = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of appts) {
      if (!a.phone || a.status === "payment_pending" || a.status === "cancelled") continue;
      const cur = m.get(a.phone);
      if (!cur || a.date < cur) m.set(a.phone, a.date);
    }
    return m;
  }, [appts]);
  const newCount = inRange.filter((a) => !a.phone || firstApptByPhone.get(a.phone) === a.date).length;
  const returningCount = inRange.length - newCount;

  // All-time patient count (unique phones)
  const allTimePatients = useMemo(() => {
    const phones = new Set<string>();
    for (const a of allActive) { if (a.phone) phones.add(a.phone); }
    return phones.size;
  }, [allActive]);

  // This month vs last month
  const now = nowIST();
  const thisMonthStart = ymd(new Date(now.getFullYear(), now.getMonth(), 1));
  const lastMonthStart = ymd(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  const lastMonthEnd = ymd(new Date(now.getFullYear(), now.getMonth(), 0));
  const thisMonthCount = allActive.filter((a) => a.date >= thisMonthStart).length;
  const lastMonthCount = allActive.filter((a) => a.date >= lastMonthStart && a.date <= lastMonthEnd).length;
  const monthDelta = lastMonthCount > 0 ? Math.round(((thisMonthCount - lastMonthCount) / lastMonthCount) * 100) : 0;

  // Busiest day of week
  const byDow = useMemo(() => {
    const counts = [0, 0, 0, 0, 0, 0, 0];
    for (const a of allActive) {
      const d = new Date(a.date + "T00:00:00").getDay();
      counts[d]++;
    }
    return counts;
  }, [allActive]);
  const maxDow = Math.max(1, ...byDow);
  const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  // Peak hours
  const byHour = useMemo(() => {
    const counts = new Map<number, number>();
    for (const a of allActive) {
      const h = parseInt(a.time.split(":")[0], 10);
      counts.set(h, (counts.get(h) ?? 0) + 1);
    }
    return counts;
  }, [allActive]);
  const hourRange = Array.from({ length: 12 }, (_, i) => i + 8); // 8am to 7pm
  const maxHour = Math.max(1, ...hourRange.map((h) => byHour.get(h) ?? 0));

  return (
    <div className="max-w-3xl space-y-6">
      {/* Practice milestone */}
      <div className="rounded-2xl border border-brand/20 bg-gradient-to-r from-brand-tint to-paper p-5">
        <div className="flex items-center gap-3">
          <div className="grid h-12 w-12 place-items-center rounded-xl bg-brand text-white">
            <TrendingUp className="h-6 w-6" />
          </div>
          <div>
            <div className="font-display text-2xl text-ink">{allTimePatients} patients</div>
            <div className="text-xs text-muted">
              {thisMonthCount} this month
              {lastMonthCount > 0 && (
                <span className={monthDelta >= 0 ? "text-in" : "text-out"}> ({monthDelta >= 0 ? "+" : ""}{monthDelta}% vs last month)</span>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-lg">Revenue & analysis</h2>
        <div className="flex self-start overflow-x-auto rounded-full border border-line bg-white p-0.5 no-scrollbar">
          {RANGE_OPTS.map((o) => (
            <button key={o.r} onClick={() => setRange(o.r)}
              className={`shrink-0 rounded-full px-2.5 py-1.5 text-[11px] font-medium transition sm:px-3 sm:text-xs ${range === o.r ? "bg-brand text-white" : "text-muted hover:text-ink"}`}>
              {o.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="Collected" value={money(total)} icon={IndianRupee} accent />
        <Stat label="Patients" value={String(inRange.length)} icon={Users} />
        <Stat label="Avg / day" value={money(Math.round(avgPerDay))} icon={TrendingUp} />
        <Stat label="Paid" value={String(collected.length)} icon={IndianRupee} />
      </div>

      {/* Daily collections */}
      <div className="rounded-2xl border border-line bg-paper p-4 sm:p-5">
        <div className="mb-3 text-sm font-semibold">Daily collections</div>
        <div className="overflow-x-auto">
          <div className="flex h-32 min-w-max items-end gap-1 px-1">
            {dateList.map((d) => {
              const v = byDate.get(d) ?? 0;
              const h = v > 0 ? Math.max(4, Math.round((v / maxDay) * 100)) : 0;
              return (
                <div key={d} title={`${dateLabel(d)}: ${money(v)}`} className="flex w-3 shrink-0 flex-col items-end justify-end sm:w-4">
                  <div className="w-full rounded-t bg-brand" style={{ height: `${h}%`, minHeight: v > 0 ? "2px" : 0 }} />
                </div>
              );
            })}
          </div>
        </div>
        <div className="mt-2 flex justify-between text-[11px] text-muted"><span>{dateLabel(start)}</span><span>{dateLabel(end)}</span></div>
      </div>

      {/* Source + new vs returning */}
      <div className="grid gap-6 sm:grid-cols-2">
        <div className="rounded-2xl border border-line bg-paper p-4 sm:p-5">
          <div className="mb-3 text-sm font-semibold">Source breakdown</div>
          <div className="space-y-2.5">
            {bySource.map((b) => {
              const S = sourceMeta[b.s];
              return (
                <div key={b.s} className="flex items-center gap-3">
                  <span className="inline-flex w-24 shrink-0 items-center gap-1.5 text-xs text-muted"><S.icon className="h-3.5 w-3.5" />{S.label}</span>
                  <div className="h-2 flex-1 rounded-full bg-line/60">
                    <div className="h-2 rounded-full bg-brand" style={{ width: `${Math.round((b.n / maxSource) * 100)}%` }} />
                  </div>
                  <span className="w-6 shrink-0 text-right text-xs font-medium">{b.n}</span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="rounded-2xl border border-line bg-paper p-4 sm:p-5">
          <div className="mb-3 text-sm font-semibold">New vs returning</div>
          <div className="flex h-2.5 overflow-hidden rounded-full bg-line/60">
            <div className="h-full bg-brand" style={{ width: `${inRange.length ? Math.round((newCount / inRange.length) * 100) : 0}%` }} />
          </div>
          <div className="mt-2 flex justify-between text-xs text-muted">
            <span><b className="text-ink">{newCount}</b> new</span>
            <span><b className="text-ink">{returningCount}</b> returning</span>
          </div>
        </div>
      </div>

      {/* Busiest day + Peak hours */}
      <div className="grid gap-6 sm:grid-cols-2">
        <div className="rounded-2xl border border-line bg-paper p-4 sm:p-5">
          <div className="mb-3 text-sm font-semibold">Busiest day of the week</div>
          <div className="space-y-1.5">
            {DOW_LABELS.map((label, i) => (
              <div key={label} className="flex items-center gap-2">
                <span className="w-8 shrink-0 text-xs text-muted">{label}</span>
                <div className="h-2 flex-1 rounded-full bg-line/60">
                  <div className="h-2 rounded-full bg-brand transition-all" style={{ width: `${Math.round((byDow[i] / maxDow) * 100)}%` }} />
                </div>
                <span className="w-5 shrink-0 text-right text-[11px] text-muted">{byDow[i]}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-2xl border border-line bg-paper p-4 sm:p-5">
          <div className="mb-3 text-sm font-semibold">Peak hours</div>
          <div className="space-y-1.5">
            {hourRange.filter((h) => (byHour.get(h) ?? 0) > 0 || (h >= 9 && h <= 19)).map((h) => {
              const count = byHour.get(h) ?? 0;
              return (
                <div key={h} className="flex items-center gap-2">
                  <span className="w-12 shrink-0 text-xs text-muted">{h > 12 ? h - 12 : h}{h >= 12 ? "pm" : "am"}</span>
                  <div className="h-2 flex-1 rounded-full bg-line/60">
                    <div className="h-2 rounded-full bg-brand transition-all" style={{ width: `${Math.round((count / maxHour) * 100)}%` }} />
                  </div>
                  <span className="w-5 shrink-0 text-right text-[11px] text-muted">{count}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, icon: Icon, accent }: { label: string; value: string; icon: typeof Users; accent?: boolean }) {
  return (
    <div className={`rounded-2xl border p-3.5 sm:p-4 ${accent ? "border-brand/30 bg-brand text-white" : "border-line bg-paper"}`}>
      <div className={`flex items-center gap-1.5 text-[11px] sm:gap-2 sm:text-xs ${accent ? "text-white/80" : "text-muted"}`}><Icon className="h-3.5 w-3.5 sm:h-4 sm:w-4" /> {label}</div>
      <div className="mt-2 font-display text-xl leading-none sm:text-3xl">{value}</div>
    </div>
  );
}
