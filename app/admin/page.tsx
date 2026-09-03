"use client";

import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import Link from "next/link";
import {
  LayoutDashboard, CalendarCog, Users, IndianRupee, ArrowLeft, Plus,
  Megaphone, PhoneCall, Check, X, Play, Clock, CircleDot, Globe, MessageCircle,
  Footprints, RotateCcw, TriangleAlert, ChevronLeft, ChevronRight, CalendarOff,
} from "lucide-react";
import { clinic } from "@/clinic.config";
import {
  useMounted, apptsForDate, addWalkIn, setStatus, togglePaid,
  resetDemo, saveSchedule, hydrateSchedule,
  setAvailabilityOverride, getOverrideMode, useScheduleTick,
  type Appt, type ApptStatus, type Source,
} from "@/lib/store";
import {
  statusAt, fmt, weekdayName, defaultWeeklyHours, applySchedule, setOverride,
  weeklyHours, exceptions, overrideRef, ymd, type WeeklyHours, type Exception,
} from "@/lib/schedule";
import { hasSupabase } from "@/lib/supabase";
import {
  useAdminAppts, dbAddWalkIn, dbTogglePaidClient,
  dbLoadScheduleClient, dbSaveScheduleClient, dbSetAvailabilityOverride,
  useDbScheduleTick,
} from "@/lib/admin-db";

function changeStatus(id: string, status: ApptStatus) {
  // DB mode goes through the API route (not a direct client write) so a
  // cancellation can also fire the WhatsApp cancellation notice server-side.
  if (hasSupabase()) {
    fetch("/api/appointments/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, status }),
    }).catch((err) => console.error("admin: could not update status", err));
  }
  else setStatus(id, status);
}
function changePaid(id: string, currentPaid: boolean) {
  if (hasSupabase()) dbTogglePaidClient(id, currentPaid).catch((err) => console.error("admin: could not toggle paid", err));
  else togglePaid(id);
}
async function addWalkInAny(f: { name: string; phone: string; reason: string }): Promise<{ token: number }> {
  return hasSupabase() ? dbAddWalkIn(f) : addWalkIn(f);
}

type Tab = "today" | "schedule" | "patients" | "revenue";
const money = (n: number) => `${clinic.currency}${n.toLocaleString("en-IN")}`;

const NAV: { id: Tab; label: string; icon: typeof Users }[] = [
  { id: "today", label: "Today", icon: LayoutDashboard },
  { id: "schedule", label: "Schedule", icon: CalendarCog },
  { id: "patients", label: "Patients", icon: Users },
  { id: "revenue", label: "Revenue", icon: IndianRupee },
];

export default function Admin() {
  const [tab, setTab] = useState<Tab>("today");
  const mounted = useMounted();
  const appts = useAdminAppts();
  const [scheduleLoaded, setScheduleLoaded] = useState(!hasSupabase());
  useEffect(() => {
    if (hasSupabase()) {
      dbLoadScheduleClient()
        .then((s) => { applySchedule(s.weekly, s.exceptions); setOverride(s.override); })
        .catch((err) => console.error("admin: could not load schedule", err))
        .finally(() => setScheduleLoaded(true));
    } else {
      hydrateSchedule();
    }
  }, []);

  return (
    <div className="min-h-screen bg-bone text-ink flex">
      {/* Sidebar */}
      <aside className="hidden md:flex w-60 shrink-0 flex-col border-r border-line bg-paper">
        <div className="px-5 py-5 border-b border-line">
          <div className="font-display text-lg leading-tight">Ramachandra<span className="text-brand"> Ortho</span></div>
          <div className="text-xs text-muted">Clinic admin</div>
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
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 min-w-0">
        {/* Topbar */}
        <div className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-line bg-bone/85 px-4 md:px-8 h-16 backdrop-blur-md">
          <div className="flex items-center gap-3">
            {/* mobile tabs */}
            <div className="md:hidden flex gap-1">
              {NAV.map((n) => (
                <button key={n.id} onClick={() => setTab(n.id)} className={`rounded-lg p-2 ${tab === n.id ? "bg-brand text-white" : "text-muted"}`}><n.icon className="h-4 w-4" /></button>
              ))}
            </div>
            <h1 className="font-display text-xl capitalize hidden sm:block">{tab}</h1>
          </div>
          <DoctorStatus />
        </div>

        <div className="p-4 md:p-8">
          {!mounted || !scheduleLoaded ? (
            <div className="text-sm text-muted">Loading…</div>
          ) : tab === "today" ? (
            <Today appts={appts} />
          ) : tab === "schedule" ? (
            <Schedule />
          ) : tab === "patients" ? (
            <Patients appts={appts} />
          ) : (
            <Revenue appts={appts} />
          )}
        </div>
      </main>
    </div>
  );
}

/* ── Doctor live status (shared availability engine) ───────────────────────── */
function DoctorStatus() {
  const [, force] = useState(0);
  useScheduleTick(); // re-render when availability override changes (mock mode)
  useDbScheduleTick(); // re-render when availability override changes (DB mode)
  useEffect(() => { const id = setInterval(() => force((n) => n + 1), 30_000); return () => clearInterval(id); }, []);
  const s = statusAt();
  const label = s.state === "in" ? "In consult now" : s.state === "soon" ? `In at ${fmt(s.opensAt)}` : "Not in today";
  const color = s.state === "in" ? "var(--color-in)" : s.state === "soon" ? "var(--color-accent)" : "var(--color-out)";
  return (
    <div className="inline-flex items-center gap-2 rounded-full border border-line bg-white px-3 py-1.5 text-sm">
      <span className="h-2 w-2 rounded-full" style={{ background: color }} />
      <span className="text-muted">Doctor:</span> <span className="font-semibold">{label}</span>
    </div>
  );
}

/* ── Availability toggle (Auto / In now / Away today) ──────────────────────── */
function AvailabilityControl() {
  useScheduleTick(); // re-render on toggle (mock mode)
  useDbScheduleTick(); // re-render on toggle (DB mode)
  const mode = getOverrideMode();
  const s = statusAt();
  const statusText =
    s.state === "in" ? `In now, until ${fmt(s.until)}`
      : s.state === "soon" ? `Consulting today from ${fmt(s.opensAt)}`
      : s.next ? `Not in. Next: ${weekdayName(s.next.date)} ${fmt(s.next.opensAt)}`
      : "Not in today";
  const color = s.state === "in" ? "var(--color-in)" : s.state === "soon" ? "var(--color-accent)" : "var(--color-out)";
  const opts: { m: "auto" | "in" | "out"; label: string; active: string }[] = [
    { m: "auto", label: "Auto (schedule)", active: "bg-brand text-white" },
    { m: "in", label: "In now", active: "bg-in text-white" },
    { m: "out", label: "Away today", active: "bg-out text-white" },
  ];
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-line bg-paper p-4 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <div className="flex items-center gap-2 text-sm font-semibold">
          <span className="pulse-dot h-2.5 w-2.5 rounded-full" style={{ color, background: color }} />
          Doctor availability
        </div>
        <div className="mt-0.5 text-xs text-muted">{statusText}. Shown live on the website and WhatsApp.</div>
      </div>
      <div className="flex self-start rounded-full border border-line bg-white p-0.5 sm:self-auto">
        {opts.map((o) => (
          <button key={o.m} onClick={() => {
            if (hasSupabase()) dbSetAvailabilityOverride(o.m).catch((err) => console.error("admin: could not set availability", err));
            else setAvailabilityOverride(o.m);
          }}
            className={`rounded-full px-3 py-1.5 text-xs font-medium transition sm:text-sm ${mode === o.m ? o.active : "text-muted hover:text-ink"}`}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ── shared date navigator (prev/next day + jump-to-date) ───────────────────── */
function DateNav({ date, setDate }: { date: string; setDate: (d: string) => void }) {
  const todayStr = ymd(new Date());
  const isToday = date === todayStr;
  const shift = (n: number) => {
    const d = new Date(date + "T00:00:00");
    d.setDate(d.getDate() + n);
    setDate(ymd(d));
  };
  return (
    <div className="flex items-center gap-1.5">
      <button onClick={() => shift(-1)} title="Previous day" className="rounded-lg border border-line p-1.5 text-muted hover:bg-line/40 hover:text-ink"><ChevronLeft className="h-4 w-4" /></button>
      <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} className="rounded-lg border border-line bg-white px-2.5 py-1.5 text-sm font-medium outline-none focus:border-brand" />
      <button onClick={() => shift(1)} title="Next day" className="rounded-lg border border-line p-1.5 text-muted hover:bg-line/40 hover:text-ink"><ChevronRight className="h-4 w-4" /></button>
      {!isToday && <button onClick={() => setDate(todayStr)} className="ml-1 rounded-full bg-brand-tint px-2.5 py-1.5 text-xs font-semibold text-brand hover:bg-brand hover:text-white">Today</button>}
    </div>
  );
}
const dateLabel = (date: string) => {
  const d = new Date(date + "T00:00:00");
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) });
};

/* ── TODAY: stats + live queue + walk-in + broadcast ───────────────────────── */
function Today({ appts }: { appts: Appt[] }) {
  const [date, setDate] = useState(() => ymd(new Date()));
  const isToday = date === ymd(new Date());
  const list = apptsForDate(appts, date);
  const active = list.filter((a) => a.status !== "cancelled");
  const inQueue = list.filter((a) => ["reserved", "confirmed", "waiting"].includes(a.status));
  const serving = list.find((a) => a.status === "consulting");
  const next = inQueue[0];
  const revenue = list.filter((a) => a.paid).reduce((s, a) => s + a.fee, 0);

  const callNext = () => {
    if (serving) changeStatus(serving.id, "done");
    const n = apptsForDate(appts, date).find((a) => ["reserved", "confirmed", "waiting"].includes(a.status));
    if (n) changeStatus(n.id, "consulting");
  };

  return (
    <div className="space-y-6">
      <AvailabilityControl />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-lg">{isToday ? "Today" : dateLabel(date)}</h2>
          <p className="text-xs text-muted">{list.length} appointment{list.length === 1 ? "" : "s"} on this date.</p>
        </div>
        <DateNav date={date} setDate={setDate} />
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat label="Appointments" value={String(active.length)} icon={CalendarCog} />
        <Stat label="In queue" value={String(inQueue.length)} icon={Clock} />
        <Stat label="Now serving" value={serving ? `#${serving.token}` : "—"} icon={CircleDot} accent />
        <Stat label="Collected" value={money(revenue)} icon={IndianRupee} />
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        {/* queue */}
        <div className="lg:col-span-2 rounded-2xl border border-line bg-paper">
          <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
            <div className="flex items-center gap-2">
              <h2 className="font-semibold">{isToday ? "Live queue" : "Queue"}</h2>
              {isToday && next && <span className="text-xs text-muted">next up: <b className="text-ink">#{next.token} {next.name}</b></span>}
            </div>
            {isToday && (
              <button onClick={callNext} className="inline-flex items-center gap-1.5 rounded-full bg-brand px-3.5 py-1.5 text-sm font-semibold text-white hover:bg-brand-dark">
                <PhoneCall className="h-4 w-4" /> Call next
              </button>
            )}
          </div>
          <ul className="divide-y divide-line">
            {list.map((a) => <QueueRow key={a.id} a={a} />)}
            {list.length === 0 && <li className="px-5 py-8 text-center text-sm text-muted">No appointments on this date.</li>}
          </ul>
        </div>

        {/* side */}
        <div className="space-y-6">
          <WalkIn />
          <Broadcast count={inQueue.length} />
        </div>
      </div>
    </div>
  );
}

const sourceMeta: Record<Source, { label: string; icon: typeof Globe }> = {
  website: { label: "Website", icon: Globe },
  whatsapp: { label: "WhatsApp", icon: MessageCircle },
  walkin: { label: "Walk-in", icon: Footprints },
};
const statusMeta: Record<ApptStatus, { label: string; cls: string }> = {
  reserved: { label: "Reserved", cls: "bg-brand-tint text-brand" },
  confirmed: { label: "Confirmed", cls: "bg-brand-tint text-brand" },
  waiting: { label: "Waiting", cls: "bg-accent-soft text-accent" },
  consulting: { label: "In consult", cls: "bg-in/15 text-in" },
  done: { label: "Done", cls: "bg-muted/15 text-muted" },
  cancelled: { label: "Cancelled", cls: "bg-out/10 text-out line-through" },
};

function QueueRow({ a }: { a: Appt }) {
  const S = sourceMeta[a.source];
  return (
    <li className={`flex items-center gap-3 px-5 py-3 ${a.status === "consulting" ? "bg-in/[0.04]" : ""}`}>
      <div className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg font-mono text-sm font-semibold ${a.status === "done" ? "bg-muted/10 text-muted" : "bg-brand text-white"}`}>{a.token}</div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{a.name}</span>
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${statusMeta[a.status].cls}`}>{statusMeta[a.status].label}</span>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted">
          <span>{fmt(a.time)}</span> · <span className="inline-flex items-center gap-1"><S.icon className="h-3 w-3" />{S.label}</span> · <span className="truncate">{a.reason}</span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {["reserved", "confirmed", "waiting"].includes(a.status) && (
          <button onClick={() => changeStatus(a.id, "consulting")} title="Start consult" className="rounded-lg border border-line p-1.5 text-brand hover:bg-brand-tint"><Play className="h-4 w-4" /></button>
        )}
        {a.status === "consulting" && (
          <button onClick={() => changeStatus(a.id, "done")} title="Mark done" className="rounded-lg border border-line p-1.5 text-in hover:bg-in/10"><Check className="h-4 w-4" /></button>
        )}
        {a.status !== "done" && a.status !== "cancelled" && (
          <button onClick={() => changeStatus(a.id, "cancelled")} title="Cancel" className="rounded-lg border border-line p-1.5 text-muted hover:text-out hover:bg-out/10"><X className="h-4 w-4" /></button>
        )}
        {a.status === "done" && (
          <button onClick={() => changePaid(a.id, a.paid)} title="Toggle paid" className={`rounded-lg border border-line px-2 py-1 text-[11px] font-medium ${a.paid ? "text-in" : "text-out"}`}>{a.paid ? "Paid" : "Unpaid"}</button>
        )}
      </div>
    </li>
  );
}

function WalkIn() {
  const [f, setF] = useState({ name: "", phone: "", reason: "" });
  const [done, setDone] = useState<null | number>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!f.name.trim()) return;
    try {
      const a = await addWalkInAny(f);
      setDone(a.token); setF({ name: "", phone: "", reason: "" });
      setTimeout(() => setDone(null), 3000);
    } catch (err) {
      console.error("admin: could not add walk-in", err);
    }
  };
  return (
    <div className="rounded-2xl border border-line bg-paper p-5">
      <h2 className="flex items-center gap-2 font-semibold"><Footprints className="h-4 w-4 text-brand" /> Walk-in / reserve</h2>
      <p className="mt-1 text-xs text-muted">Patient at the desk? Add them to today&apos;s queue and issue a token.</p>
      <form onSubmit={submit} className="mt-3 space-y-2">
        <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Patient name" className="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm outline-none focus:border-brand" />
        <input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="Phone (optional)" inputMode="tel" className="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm outline-none focus:border-brand" />
        <input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="Reason (e.g. knee pain)" className="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm outline-none focus:border-brand" />
        <button className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-brand py-2.5 text-sm font-semibold text-white hover:bg-brand-dark"><Plus className="h-4 w-4" /> Add to queue</button>
      </form>
      {done && <div className="mt-2 rounded-lg bg-in/10 px-3 py-2 text-sm text-in">Added · token <b>#{done}</b> issued.</div>}
    </div>
  );
}

function Broadcast({ count }: { count: number }) {
  const [mins, setMins] = useState(30);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ msg: string; note: string } | null>(null);

  const send = async (msg: string) => {
    setSending(true);
    try {
      if (hasSupabase()) {
        const res = await fetch("/api/admin/broadcast", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: msg }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || "send failed");
        const note = data.attempted === 0
          ? "No patients with a phone number in today's queue."
          : `Attempted ${data.attempted}${data.failed ? `, ${data.failed} did not deliver (only patients in an active WhatsApp conversation receive this)` : ", all queued for delivery"}.`;
        setResult({ msg, note });
      } else {
        setResult({ msg, note: `Simulated — sent to ${count} patients (demo mode).` });
      }
    } catch (err) {
      console.error("admin: broadcast failed", err);
      setResult({ msg, note: "Could not send. Check the WhatsApp connection." });
    } finally {
      setSending(false);
      setTimeout(() => setResult(null), 6000);
    }
  };

  return (
    <div className="rounded-2xl border border-line bg-paper p-5">
      <h2 className="flex items-center gap-2 font-semibold"><Megaphone className="h-4 w-4 text-accent" /> Broadcast</h2>
      <p className="mt-1 text-xs text-muted">Notify today&apos;s {count} waiting patients on WhatsApp in one tap.</p>
      <div className="mt-3 space-y-2">
        <div className="flex items-center gap-2">
          <button disabled={sending} onClick={() => send(`Dr. Ramachandra is running about ${mins} minutes late today. Sorry for the wait.`)} className="flex-1 rounded-lg border border-line py-2 text-sm font-medium hover:border-accent/50 disabled:opacity-50">Running late</button>
          <input type="number" value={mins} onChange={(e) => setMins(+e.target.value)} className="w-16 rounded-lg border border-line bg-white px-2 py-2 text-sm" />
          <span className="text-xs text-muted">min</span>
        </div>
        <button disabled={sending} onClick={() => send("The clinic is closed today. We are sorry for the inconvenience and will help you rebook.")} className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-out/30 py-2 text-sm font-medium text-out hover:bg-out/5 disabled:opacity-50"><TriangleAlert className="h-4 w-4" /> Clinic closed today</button>
      </div>
      {result && <div className="mt-3 rounded-lg bg-brand-tint px-3 py-2 text-xs text-brand"><b>“{result.msg}”</b><br />{result.note}</div>}
    </div>
  );
}

function Stat({ label, value, icon: Icon, accent }: { label: string; value: string; icon: typeof Users; accent?: boolean }) {
  return (
    <div className={`rounded-2xl border p-4 ${accent ? "border-brand/30 bg-brand text-white" : "border-line bg-paper"}`}>
      <div className={`flex items-center gap-2 text-xs ${accent ? "text-white/80" : "text-muted"}`}><Icon className="h-4 w-4" /> {label}</div>
      <div className="mt-2 font-display text-3xl">{value}</div>
    </div>
  );
}

/* ── SCHEDULE editor ───────────────────────────────────────────────────────── */
const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function Schedule() {
  // By the time this tab is reachable, the top-level Admin() effect has
  // already loaded the real schedule (mock or DB) into the weeklyHours
  // singleton — so seeding from it here is source-agnostic.
  const [weekly, setWeekly] = useState<WeeklyHours>(() => {
    const w: WeeklyHours = {};
    for (let d = 0; d <= 6; d++) w[d] = (weeklyHours[d] ?? []).map((x) => ({ ...x }));
    return w;
  });
  const [ex, setEx] = useState<Record<string, Exception>>(() => ({ ...exceptions }));
  const [saved, setSaved] = useState(false);

  const setWin = (d: number, i: number, key: "start" | "end", v: string) =>
    setWeekly((w) => ({ ...w, [d]: w[d].map((win, j) => (j === i ? { ...win, [key]: v } : win)) }));
  const addWin = (d: number) => setWeekly((w) => ({ ...w, [d]: [...w[d], { start: "18:00", end: "19:45" }] }));
  const rmWin = (d: number, i: number) => setWeekly((w) => ({ ...w, [d]: w[d].filter((_, j) => j !== i) }));

  const save = async () => {
    try {
      if (hasSupabase()) await dbSaveScheduleClient(weekly, ex, overrideRef.current);
      else saveSchedule(weekly, ex, overrideRef.current);
      setSaved(true); setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      console.error("admin: could not save schedule", err);
    }
  };
  const reset = () => setWeekly(defaultWeeklyHours());

  return (
    <div className="max-w-3xl space-y-4">
      <div className="rounded-2xl border border-line bg-paper p-5">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-semibold">Weekly consulting hours</h2>
            <p className="text-xs text-muted">This drives the live availability on the website and the WhatsApp bot. Mon–Sat share the same OPD hours by default; Sunday is the weekly holiday.</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={reset} className="inline-flex items-center gap-1.5 rounded-full border border-line px-4 py-2 text-sm font-medium text-ink hover:bg-line/40"><RotateCcw className="h-3.5 w-3.5" /> Reset to default</button>
            <button onClick={save} className="rounded-full bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-dark">Save</button>
          </div>
        </div>
        <div className="mt-4 divide-y divide-line">
          {[1, 2, 3, 4, 5, 6, 0].map((d) => (
            <div key={d} className="flex items-start gap-4 py-3">
              <div className="w-12 pt-1.5 text-sm font-semibold text-ink">{DAY_LABELS[d]}</div>
              <div className="flex-1 space-y-2">
                {weekly[d].length === 0 && <div className="py-1.5 text-sm text-muted">Closed</div>}
                {weekly[d].map((w, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input type="time" value={w.start} onChange={(e) => setWin(d, i, "start", e.target.value)} className="rounded-lg border border-line bg-white px-2 py-1.5 text-sm" />
                    <span className="text-muted">–</span>
                    <input type="time" value={w.end} onChange={(e) => setWin(d, i, "end", e.target.value)} className="rounded-lg border border-line bg-white px-2 py-1.5 text-sm" />
                    <button onClick={() => rmWin(d, i)} className="rounded-lg p-1.5 text-muted hover:text-out"><X className="h-4 w-4" /></button>
                  </div>
                ))}
                <button onClick={() => addWin(d)} className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline"><Plus className="h-3 w-3" /> Add window</button>
              </div>
            </div>
          ))}
        </div>
        {saved && <div className="mt-3 rounded-lg bg-in/10 px-3 py-2 text-sm text-in">Saved. Website and WhatsApp availability updated.</div>}
      </div>

      <ExceptionsEditor ex={ex} setEx={setEx} />
    </div>
  );
}

function ExceptionsEditor({ ex, setEx }: { ex: Record<string, Exception>; setEx: Dispatch<SetStateAction<Record<string, Exception>>> }) {
  const [newDate, setNewDate] = useState("");
  const [newNote, setNewNote] = useState("");
  const dates = Object.keys(ex).sort();

  const add = () => {
    if (!newDate) return;
    setEx((e) => ({ ...e, [newDate]: { closed: true, note: newNote.trim() || undefined } }));
    setNewDate(""); setNewNote("");
  };
  const remove = (d: string) => setEx((e) => { const n = { ...e }; delete n[d]; return n; });

  return (
    <div className="rounded-2xl border border-line bg-paper p-5">
      <h2 className="font-semibold">Holidays &amp; date overrides</h2>
      <p className="text-xs text-muted">Mark a specific date closed (festival, doctor leave) — overrides the weekly hours above for just that date. Remember to hit Save.</p>

      <div className="mt-4 space-y-2">
        {dates.length === 0 && <div className="text-sm text-muted">No overrides set.</div>}
        {dates.map((d) => (
          <div key={d} className="flex items-center gap-2 rounded-lg border border-line bg-white px-3 py-2 text-sm">
            <CalendarOff className="h-4 w-4 shrink-0 text-out" />
            <span className="font-medium">{dateLabel(d)}</span>
            <span className="text-muted truncate">Closed{ex[d].note ? ` · ${ex[d].note}` : ""}</span>
            <button onClick={() => remove(d)} title="Remove" className="ml-auto shrink-0 rounded-lg p-1 text-muted hover:text-out"><X className="h-4 w-4" /></button>
          </div>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)} className="rounded-lg border border-line bg-white px-2.5 py-1.5 text-sm" />
        <input value={newNote} onChange={(e) => setNewNote(e.target.value)} placeholder="Note (optional, e.g. Diwali)" className="min-w-[10rem] flex-1 rounded-lg border border-line bg-white px-2.5 py-1.5 text-sm outline-none focus:border-brand" />
        <button onClick={add} disabled={!newDate} className="inline-flex items-center gap-1 rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-brand hover:bg-brand-tint disabled:opacity-50"><Plus className="h-3.5 w-3.5" /> Add</button>
      </div>
    </div>
  );
}

/* ── PATIENTS ──────────────────────────────────────────────────────────────── */
function Patients({ appts }: { appts: Appt[] }) {
  const [q, setQ] = useState("");
  const list = useMemo(() => {
    const by = new Map<string, { name: string; phone: string; visits: number; last: Appt }>();
    for (const a of [...appts].sort((x, y) => y.createdAt - x.createdAt)) {
      const k = a.phone || a.name;
      const cur = by.get(k);
      if (cur) cur.visits++;
      else by.set(k, { name: a.name, phone: a.phone, visits: 1, last: a });
    }
    return [...by.values()].filter((p) => (p.name + p.phone).toLowerCase().includes(q.toLowerCase()));
  }, [appts, q]);
  return (
    <div className="max-w-3xl">
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search patients…" className="mb-4 w-full max-w-sm rounded-lg border border-line bg-white px-3 py-2 text-sm outline-none focus:border-brand" />
      <div className="rounded-2xl border border-line bg-paper divide-y divide-line">
        {list.map((p) => (
          <div key={p.phone + p.name} className="flex items-center gap-3 px-5 py-3">
            <span className="grid h-9 w-9 place-items-center rounded-full bg-brand-tint text-sm font-semibold text-brand">{p.name[0]}</span>
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{p.name}</div>
              <div className="text-xs text-muted">{p.phone || "no phone"} · last: {p.last.reason}</div>
            </div>
            <span className="rounded-full bg-brand-tint px-2.5 py-1 text-xs font-medium text-brand">{p.visits} visit{p.visits > 1 ? "s" : ""}</span>
          </div>
        ))}
        {list.length === 0 && <div className="px-5 py-8 text-center text-sm text-muted">No patients.</div>}
      </div>
      <p className="mt-3 text-xs text-muted">Basic patient records (beta). Full history, prescriptions and reports come later.</p>
    </div>
  );
}

/* ── REVENUE ───────────────────────────────────────────────────────────────── */
function Revenue({ appts }: { appts: Appt[] }) {
  const [date, setDate] = useState(() => ymd(new Date()));
  const isToday = date === ymd(new Date());
  const list = apptsForDate(appts, date).filter((a) => a.paid);
  const total = list.reduce((s, a) => s + a.fee, 0);
  const bySource = (["website", "whatsapp", "walkin"] as Source[]).map((s) => ({
    s, n: list.filter((a) => a.source === s).length,
  }));
  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-lg">{isToday ? "Today" : dateLabel(date)}</h2>
        <DateNav date={date} setDate={setDate} />
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="Collected" value={money(total)} icon={IndianRupee} accent />
        <Stat label="Consults paid" value={String(list.length)} icon={Check} />
        {bySource.map((b) => (
          <Stat key={b.s} label={sourceMeta[b.s].label} value={String(b.n)} icon={sourceMeta[b.s].icon} />
        ))}
      </div>
      <div className="rounded-2xl border border-line bg-paper">
        <div className="border-b border-line px-5 py-3.5 font-semibold">Collections {isToday ? "today" : `on ${dateLabel(date)}`}</div>
        <ul className="divide-y divide-line">
          {list.map((a) => (
            <li key={a.id} className="flex items-center justify-between px-5 py-3 text-sm">
              <span className="flex items-center gap-2"><span className="font-mono text-xs text-muted">#{a.token}</span> {a.name}</span>
              <span className="font-medium">{money(a.fee)}</span>
            </li>
          ))}
          {list.length === 0 && <li className="px-5 py-8 text-center text-sm text-muted">No collections on this date.</li>}
        </ul>
      </div>
      <p className="text-xs text-muted">Beta: consultation fees only. Procedures, UPI reconciliation and trends come later.</p>
    </div>
  );
}
