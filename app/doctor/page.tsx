"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Calendar as CalendarIcon, Users, IndianRupee, ArrowLeft, LogOut, RotateCcw,
  ChevronLeft, ChevronRight, Globe, MessageCircle, Footprints, TrendingUp,
} from "lucide-react";
import { clinic } from "@/clinic.config";
import { useMounted, apptsForDate, resetDemo, setNotes, type Appt, type ApptStatus, type Source } from "@/lib/store";
import { ymd, fmt } from "@/lib/schedule";
import { hasSupabase, supabaseBrowser } from "@/lib/supabase";
import { useAdminAppts, dbSetNotes } from "@/lib/admin-db";

// Only relevant in DB mode — mock mode has no Supabase session to sign out
// of, and proxy.ts doesn't gate /doctor at all when Supabase isn't configured.
async function signOutStaff() {
  await supabaseBrowser().auth.signOut();
  window.location.href = "/login";
}

async function saveNote(id: string, notes: string) {
  if (hasSupabase()) await dbSetNotes(id, notes);
  else setNotes(id, notes);
}

type Tab = "calendar" | "patients" | "revenue";
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
};

const NAV: { id: Tab; label: string; icon: typeof Users }[] = [
  { id: "calendar", label: "Calendar", icon: CalendarIcon },
  { id: "patients", label: "Patients", icon: Users },
  { id: "revenue", label: "Revenue & analysis", icon: IndianRupee },
];

export default function Doctor() {
  const [tab, setTab] = useState<Tab>("calendar");
  const mounted = useMounted();
  const [appts] = useAdminAppts();

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
            {/* mobile tabs */}
            <div className="md:hidden flex gap-1">
              {NAV.map((n) => (
                <button key={n.id} onClick={() => setTab(n.id)} className={`rounded-lg p-2 ${tab === n.id ? "bg-brand text-white" : "text-muted"}`}><n.icon className="h-4 w-4" /></button>
              ))}
            </div>
            <h1 className="font-display text-xl hidden sm:block">{NAV.find((n) => n.id === tab)?.label}</h1>
          </div>
          {hasSupabase() && (
            <button onClick={signOutStaff} className="md:hidden rounded-lg p-2 text-muted hover:text-out" aria-label="Sign out"><LogOut className="h-4 w-4" /></button>
          )}
        </div>

        <div className="p-4 md:p-8">
          {!mounted ? (
            <div className="text-sm text-muted">Loading…</div>
          ) : tab === "calendar" ? (
            <DoctorCalendar appts={appts} />
          ) : tab === "patients" ? (
            <DoctorPatients appts={appts} />
          ) : (
            <RevenueAnalysis appts={appts} />
          )}
        </div>
      </main>
    </div>
  );
}

/* ── CALENDAR: month grid + day drill-down + clinical notes ─────────────────── */
const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function monthMatrix(year: number, month: number): (string | null)[] {
  const startWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: (string | null)[] = Array.from({ length: startWeekday }, () => null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(ymd(new Date(year, month, d)));
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

function DoctorCalendar({ appts }: { appts: Appt[] }) {
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());
  const [selected, setSelected] = useState(ymd(today));
  const todayStr = ymd(today);

  const countsByDate = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of appts) {
      if (a.status === "cancelled") continue;
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
  const dayList = apptsForDate(appts, selected);

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
          {dayList.map((a) => <DayApptRow key={a.id} a={a} />)}
          {dayList.length === 0 && <li className="px-5 py-8 text-center text-sm text-muted">No appointments.</li>}
        </ul>
      </div>
    </div>
  );
}

function DayApptRow({ a }: { a: Appt }) {
  const [notes, setLocalNotes] = useState(a.notes ?? "");
  const [saved, setSaved] = useState(true);
  useEffect(() => { setLocalNotes(a.notes ?? ""); setSaved(true); }, [a.id, a.notes]);
  const S = sourceMeta[a.source];

  const commit = () => {
    if (notes === (a.notes ?? "")) return;
    saveNote(a.id, notes).then(() => setSaved(true)).catch((err) => console.error("doctor: could not save note", err));
  };

  return (
    <li className="px-5 py-3.5">
      <div className="flex items-center gap-3">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand-tint font-mono text-xs font-semibold text-brand">{a.token}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{a.name}</span>
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${statusMeta[a.status].cls}`}>{statusMeta[a.status].label}</span>
          </div>
          <div className="flex items-center gap-1 text-xs text-muted">
            <span>{fmt(a.time)}</span> · <span className="inline-flex items-center gap-1"><S.icon className="h-3 w-3" />{S.label}</span> · <span>{a.reason}</span>
            {a.phone && <span>· {a.phone}</span>}
          </div>
        </div>
      </div>
      <textarea
        value={notes}
        onChange={(e) => { setLocalNotes(e.target.value); setSaved(false); }}
        onBlur={commit}
        placeholder="Clinical note — visible only in this portal"
        rows={2}
        className="mt-2 w-full resize-none rounded-lg border border-line bg-white px-3 py-2 text-sm outline-none focus:border-brand"
      />
      {!saved && <div className="mt-1 text-[11px] text-muted">Saving…</div>}
    </li>
  );
}

/* ── PATIENTS ─────────────────────────────────────────────────────────────── */
function DoctorPatients({ appts }: { appts: Appt[] }) {
  const [q, setQ] = useState("");
  const list = useMemo(() => {
    const by = new Map<string, { name: string; phone: string; visits: number; last: Appt }>();
    for (const a of [...appts].sort((x, y) => y.createdAt - x.createdAt)) {
      const k = a.phone ? `p:${a.phone}` : `a:${a.id}`;
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
          <div key={p.last.id} className="flex items-center gap-3 px-5 py-3">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand-tint text-sm font-semibold text-brand">{p.name[0]}</span>
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{p.name}</div>
              <div className="text-xs text-muted">{p.phone || "no phone"} · last: {p.last.reason}</div>
              {p.last.notes && <div className="truncate text-xs italic text-muted">note: {p.last.notes}</div>}
            </div>
            <span className="shrink-0 rounded-full bg-brand-tint px-2.5 py-1 text-xs font-medium text-brand">{p.visits} visit{p.visits > 1 ? "s" : ""}</span>
          </div>
        ))}
        {list.length === 0 && <div className="px-5 py-8 text-center text-sm text-muted">No patients.</div>}
      </div>
    </div>
  );
}

/* ── REVENUE & ANALYSIS ──────────────────────────────────────────────────── */
type Range = "today" | "week" | "month" | "last30";
const RANGE_OPTS: { r: Range; label: string }[] = [
  { r: "today", label: "Today" },
  { r: "week", label: "This week" },
  { r: "month", label: "This month" },
  { r: "last30", label: "Last 30 days" },
];

function rangeBounds(range: Range): { start: string; end: string } {
  const today = new Date();
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

function RevenueAnalysis({ appts }: { appts: Appt[] }) {
  const [range, setRange] = useState<Range>("month");
  const { start, end } = rangeBounds(range);
  const inRange = useMemo(() => appts.filter((a) => a.date >= start && a.date <= end), [appts, start, end]);
  const active = inRange.filter((a) => a.status !== "cancelled");
  // Net, not gross: a refunded row's money came in then went out, so it's
  // excluded from "collected" the same way lib/store.ts's revenue math treats it.
  const collected = inRange.filter((a) => a.paid && a.refundedAt == null);
  const total = collected.reduce((s, a) => s + a.fee, 0);
  const dateList = useMemo(() => dateRangeList(start, end), [start, end]);
  const avgPerDay = total / dateList.length;

  const byDate = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of collected) m.set(a.date, (m.get(a.date) ?? 0) + a.fee);
    return m;
  }, [collected]);
  const maxDay = Math.max(1, ...dateList.map((d) => byDate.get(d) ?? 0));

  const bySource = (["website", "whatsapp", "walkin"] as Source[]).map((s) => ({ s, n: active.filter((a) => a.source === s).length }));
  const maxSource = Math.max(1, ...bySource.map((b) => b.n));

  // First-ever appointment date per phone, across ALL history (not just the
  // selected range) — an in-range visit counts as "new" only if it IS that
  // patient's first-ever visit, otherwise they were already a patient before
  // this range started. A walk-in with no phone can't be matched to history,
  // so it's counted as new (mirrors the Patients tab's own dedup rule).
  const firstApptByPhone = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of appts) {
      if (!a.phone) continue;
      const cur = m.get(a.phone);
      if (!cur || a.date < cur) m.set(a.phone, a.date);
    }
    return m;
  }, [appts]);
  const newCount = active.filter((a) => !a.phone || firstApptByPhone.get(a.phone) === a.date).length;
  const returningCount = active.length - newCount;

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-lg">Revenue & analysis</h2>
        <div className="flex self-start rounded-full border border-line bg-white p-0.5">
          {RANGE_OPTS.map((o) => (
            <button key={o.r} onClick={() => setRange(o.r)}
              className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${range === o.r ? "bg-brand text-white" : "text-muted hover:text-ink"}`}>
              {o.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="Collected" value={money(total)} icon={IndianRupee} accent />
        <Stat label="Appointments" value={String(active.length)} icon={Users} />
        <Stat label="Avg / day" value={money(Math.round(avgPerDay))} icon={TrendingUp} />
        <Stat label="Consults paid" value={String(collected.length)} icon={IndianRupee} />
      </div>

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
        <div className="mb-3 text-sm font-semibold">New vs. returning patients</div>
        <div className="flex h-2.5 overflow-hidden rounded-full bg-line/60">
          <div className="h-full bg-brand" style={{ width: `${active.length ? Math.round((newCount / active.length) * 100) : 0}%` }} />
        </div>
        <div className="mt-2 flex justify-between text-xs text-muted">
          <span><b className="text-ink">{newCount}</b> new</span>
          <span><b className="text-ink">{returningCount}</b> returning</span>
        </div>
      </div>
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
