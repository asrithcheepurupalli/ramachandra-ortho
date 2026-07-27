"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  LayoutDashboard, CalendarCog, Users, IndianRupee, ArrowLeft, Plus,
  Megaphone, PhoneCall, Check, X, Play, Clock, CircleDot, Globe, MessageCircle,
  Footprints, RotateCcw, TriangleAlert,
} from "lucide-react";
import { clinic } from "@/clinic.config";
import {
  useAppts, useMounted, todaysAppts, addWalkIn, setStatus, togglePaid,
  resetDemo, loadSchedule, saveSchedule, hydrateSchedule,
  setAvailabilityOverride, getOverrideMode, useScheduleTick,
  type Appt, type ApptStatus, type Source,
} from "@/lib/store";
import { statusAt, fmt, weekdayName, type WeeklyHours } from "@/lib/schedule";

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
  const appts = useAppts();
  useEffect(() => { hydrateSchedule(); }, []);

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
          <button onClick={resetDemo} className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-xs text-muted hover:text-out"><RotateCcw className="h-3.5 w-3.5" /> Reset demo data</button>
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
          {!mounted ? (
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
  useScheduleTick(); // re-render when availability override changes
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
  useScheduleTick(); // re-render on toggle
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
          <button key={o.m} onClick={() => setAvailabilityOverride(o.m)}
            className={`rounded-full px-3 py-1.5 text-xs font-medium transition sm:text-sm ${mode === o.m ? o.active : "text-muted hover:text-ink"}`}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ── TODAY: stats + live queue + walk-in + broadcast ───────────────────────── */
function Today({ appts }: { appts: Appt[] }) {
  const today = todaysAppts(appts);
  const active = today.filter((a) => a.status !== "cancelled");
  const inQueue = today.filter((a) => ["reserved", "confirmed", "waiting"].includes(a.status));
  const serving = today.find((a) => a.status === "consulting");
  const next = inQueue[0];
  const revenue = today.filter((a) => a.paid).reduce((s, a) => s + a.fee, 0);

  const callNext = () => {
    if (serving) setStatus(serving.id, "done");
    const n = todaysAppts(appts).find((a) => ["reserved", "confirmed", "waiting"].includes(a.status));
    if (n) setStatus(n.id, "consulting");
  };

  return (
    <div className="space-y-6">
      <AvailabilityControl />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat label="Appointments today" value={String(active.length)} icon={CalendarCog} />
        <Stat label="In queue" value={String(inQueue.length)} icon={Clock} />
        <Stat label="Now serving" value={serving ? `#${serving.token}` : "—"} icon={CircleDot} accent />
        <Stat label="Collected today" value={money(revenue)} icon={IndianRupee} />
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        {/* queue */}
        <div className="lg:col-span-2 rounded-2xl border border-line bg-paper">
          <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
            <div className="flex items-center gap-2">
              <h2 className="font-semibold">Live queue</h2>
              {next && <span className="text-xs text-muted">next up: <b className="text-ink">#{next.token} {next.name}</b></span>}
            </div>
            <button onClick={callNext} className="inline-flex items-center gap-1.5 rounded-full bg-brand px-3.5 py-1.5 text-sm font-semibold text-white hover:bg-brand-dark">
              <PhoneCall className="h-4 w-4" /> Call next
            </button>
          </div>
          <ul className="divide-y divide-line">
            {today.map((a) => <QueueRow key={a.id} a={a} />)}
            {today.length === 0 && <li className="px-5 py-8 text-center text-sm text-muted">No appointments today yet.</li>}
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
          <button onClick={() => setStatus(a.id, "consulting")} title="Start consult" className="rounded-lg border border-line p-1.5 text-brand hover:bg-brand-tint"><Play className="h-4 w-4" /></button>
        )}
        {a.status === "consulting" && (
          <button onClick={() => setStatus(a.id, "done")} title="Mark done" className="rounded-lg border border-line p-1.5 text-in hover:bg-in/10"><Check className="h-4 w-4" /></button>
        )}
        {a.status !== "done" && a.status !== "cancelled" && (
          <button onClick={() => setStatus(a.id, "cancelled")} title="Cancel" className="rounded-lg border border-line p-1.5 text-muted hover:text-out hover:bg-out/10"><X className="h-4 w-4" /></button>
        )}
        {a.status === "done" && (
          <button onClick={() => togglePaid(a.id)} title="Toggle paid" className={`rounded-lg border border-line px-2 py-1 text-[11px] font-medium ${a.paid ? "text-in" : "text-out"}`}>{a.paid ? "Paid" : "Unpaid"}</button>
        )}
      </div>
    </li>
  );
}

function WalkIn() {
  const [f, setF] = useState({ name: "", phone: "", reason: "" });
  const [done, setDone] = useState<null | number>(null);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!f.name.trim()) return;
    const a = addWalkIn(f);
    setDone(a.token); setF({ name: "", phone: "", reason: "" });
    setTimeout(() => setDone(null), 3000);
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
  const [sent, setSent] = useState<string | null>(null);
  const send = (msg: string) => { setSent(msg); setTimeout(() => setSent(null), 3500); };
  return (
    <div className="rounded-2xl border border-line bg-paper p-5">
      <h2 className="flex items-center gap-2 font-semibold"><Megaphone className="h-4 w-4 text-accent" /> Broadcast</h2>
      <p className="mt-1 text-xs text-muted">Notify all {count} waiting patients on WhatsApp in one tap.</p>
      <div className="mt-3 space-y-2">
        <div className="flex items-center gap-2">
          <button onClick={() => send(`Dr. Ramachandra is running about ${mins} minutes late today. Sorry for the wait.`)} className="flex-1 rounded-lg border border-line py-2 text-sm font-medium hover:border-accent/50">Running late</button>
          <input type="number" value={mins} onChange={(e) => setMins(+e.target.value)} className="w-16 rounded-lg border border-line bg-white px-2 py-2 text-sm" />
          <span className="text-xs text-muted">min</span>
        </div>
        <button onClick={() => send("The clinic is closed today. We are sorry for the inconvenience and will help you rebook.")} className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-out/30 py-2 text-sm font-medium text-out hover:bg-out/5"><TriangleAlert className="h-4 w-4" /> Clinic closed today</button>
      </div>
      {sent && <div className="mt-3 rounded-lg bg-brand-tint px-3 py-2 text-xs text-brand"><b>Sent to {count} patients:</b> “{sent}”</div>}
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
  const init = loadSchedule();
  const [weekly, setWeekly] = useState<WeeklyHours>(() => {
    const w: WeeklyHours = {};
    for (let d = 0; d <= 6; d++) w[d] = (init.weekly[d] ?? []).map((x) => ({ ...x }));
    return w;
  });
  const [saved, setSaved] = useState(false);

  const setWin = (d: number, i: number, key: "start" | "end", v: string) =>
    setWeekly((w) => ({ ...w, [d]: w[d].map((win, j) => (j === i ? { ...win, [key]: v } : win)) }));
  const addWin = (d: number) => setWeekly((w) => ({ ...w, [d]: [...w[d], { start: "18:00", end: "20:00" }] }));
  const rmWin = (d: number, i: number) => setWeekly((w) => ({ ...w, [d]: w[d].filter((_, j) => j !== i) }));

  const save = () => { saveSchedule(weekly, init.exceptions, init.override); setSaved(true); setTimeout(() => setSaved(false), 2500); };

  return (
    <div className="max-w-3xl space-y-4">
      <div className="rounded-2xl border border-line bg-paper p-5">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-semibold">Weekly consulting hours</h2>
            <p className="text-xs text-muted">This drives the live availability on the website and the WhatsApp bot. Saturday is off by default; open it whenever the doctor is in.</p>
          </div>
          <button onClick={save} className="rounded-full bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-dark">Save</button>
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
  const today = todaysAppts(appts).filter((a) => a.paid);
  const total = today.reduce((s, a) => s + a.fee, 0);
  const bySource = (["website", "whatsapp", "walkin"] as Source[]).map((s) => ({
    s, n: today.filter((a) => a.source === s).length,
  }));
  return (
    <div className="max-w-3xl space-y-6">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="Collected today" value={money(total)} icon={IndianRupee} accent />
        <Stat label="Consults paid" value={String(today.length)} icon={Check} />
        {bySource.map((b) => (
          <Stat key={b.s} label={sourceMeta[b.s].label} value={String(b.n)} icon={sourceMeta[b.s].icon} />
        ))}
      </div>
      <div className="rounded-2xl border border-line bg-paper">
        <div className="border-b border-line px-5 py-3.5 font-semibold">Today&apos;s collections</div>
        <ul className="divide-y divide-line">
          {today.map((a) => (
            <li key={a.id} className="flex items-center justify-between px-5 py-3 text-sm">
              <span className="flex items-center gap-2"><span className="font-mono text-xs text-muted">#{a.token}</span> {a.name}</span>
              <span className="font-medium">{money(a.fee)}</span>
            </li>
          ))}
          {today.length === 0 && <li className="px-5 py-8 text-center text-sm text-muted">No collections yet.</li>}
        </ul>
      </div>
      <p className="text-xs text-muted">Beta: consultation fees only. Procedures, UPI reconciliation and trends come later.</p>
    </div>
  );
}
