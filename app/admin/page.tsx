"use client";

import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import Link from "next/link";
import {
  LayoutDashboard, CalendarCog, Users, IndianRupee, ArrowLeft, Plus,
  Megaphone, PhoneCall, Check, X, Play, Clock, CircleDot, Globe, MessageCircle,
  Footprints, RotateCcw, TriangleAlert, ChevronLeft, ChevronRight, CalendarOff, LogOut, Send,
} from "lucide-react";
import { clinic } from "@/clinic.config";
import {
  useMounted, apptsForDate, addWalkIn, setStatus, togglePaid,
  resetDemo, saveSchedule, hydrateSchedule,
  setAvailabilityOverride, getOverrideMode, useScheduleTick, ageGenderLabel,
  type Appt, type ApptStatus, type Source,
} from "@/lib/store";
import {
  statusAt, fmt, weekdayName, defaultWeeklyHours, applySchedule, setOverride,
  weeklyHours, exceptions, overrideRef, ymd, windowsFor, allSlotsFor, isPastLeadTime,
  type WeeklyHours, type Exception,
} from "@/lib/schedule";
import { hasSupabase, supabaseBrowser } from "@/lib/supabase";
import {
  useAdminAppts, dbAddWalkIn, dbTogglePaidClient,
  dbLoadScheduleClient, dbSaveScheduleClient, dbSetAvailabilityOverride,
  useDbScheduleTick,
} from "@/lib/admin-db";
import { CalendarView } from "@/components/admin/CalendarView";

type Patch = (id: string, p: Partial<Appt>) => void;

function changeStatus(id: string, status: ApptStatus, prevStatus: ApptStatus, patch: Patch) {
  // Reflect the change immediately — the API call (and, for a cancel, the
  // WhatsApp send it triggers) can take a couple of seconds, and the desk
  // shouldn't stare at an unresponsive button while that happens.
  patch(id, { status });
  // DB mode goes through the API route (not a direct client write) so a
  // cancellation can also fire the WhatsApp cancellation notice server-side.
  if (hasSupabase()) {
    fetch("/api/appointments/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, status }),
    })
      .then((res) => { if (!res.ok) throw new Error(String(res.status)); })
      .catch((err) => {
        console.error("admin: could not update status", err);
        patch(id, { status: prevStatus }); // revert the optimistic flip
      });
  }
  else setStatus(id, status);
}
function changePaid(id: string, current: Pick<Appt, "paid" | "paidVia">, patch: Patch) {
  patch(id, { paid: !current.paid, paidVia: !current.paid ? "cash" : null });
  if (hasSupabase()) {
    dbTogglePaidClient(id, current.paid).catch((err) => {
      console.error("admin: could not toggle paid", err);
      patch(id, current); // revert
    });
  }
  else togglePaid(id);
}
async function addWalkInAny(f: { name: string; phone: string; age: number; gender?: "M" | "F" | null }): Promise<Appt> {
  const appt = hasSupabase() ? await dbAddWalkIn(f) : await addWalkIn(f);
  // Fire-and-forget email to the clinic for desk walk-ins. Online/WhatsApp
  // bookings get their notice from the payment webhook; walk-ins need this.
  if (hasSupabase()) {
    fetch("/api/admin/notify-new", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: appt.token, name: appt.name, phone: appt.phone, date: appt.date, time: appt.time, fee: appt.fee, patientCode: appt.patientCode }),
    }).catch(() => {});
  }
  return appt;
}

// Only relevant in DB mode — mock mode has no Supabase session to sign out
// of, and proxy.ts doesn't gate /admin at all when Supabase isn't configured.
async function signOutStaff() {
  await supabaseBrowser().auth.signOut();
  window.location.href = "/login";
}

type Tab = "today" | "schedule" | "calendar" | "patients" | "revenue" | "bugdesk";
const money = (n: number) => `${clinic.currency}${n.toLocaleString("en-IN")}`;

const NAV: { id: Tab; label: string; icon: typeof Users }[] = [
  { id: "today", label: "Today", icon: LayoutDashboard },
  { id: "schedule", label: "Schedule", icon: CalendarCog },
  { id: "calendar", label: "Calendar", icon: CalendarOff },
  { id: "patients", label: "Patients", icon: Users },
  { id: "revenue", label: "Revenue", icon: IndianRupee },
  { id: "bugdesk", label: "Bug desk", icon: TriangleAlert },
];

export default function Admin() {
  const [tab, setTab] = useState<Tab>("today");
  const mounted = useMounted();
  const [appts, patchAppt] = useAdminAppts();
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
      <aside className="hidden md:flex w-64 shrink-0 flex-col border-r border-line bg-paper">
        <div className="px-5 py-5 border-b border-line">
          <div className="font-display text-lg leading-tight">Ramachandra<span className="text-brand"> Ortho</span></div>
          <div className="text-xs text-muted">Clinic admin</div>
        </div>
        <nav className="flex-1 p-3 space-y-1">
          {NAV.map((n) => (
            <button key={n.id} onClick={() => setTab(n.id)}
              className={`flex w-full items-center gap-3 rounded-xl px-4 py-3 text-[15px] font-medium transition ${tab === n.id ? "bg-brand text-white" : "text-muted hover:bg-brand-tint/60 hover:text-ink"}`}>
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
            <h1 className="font-display text-2xl capitalize hidden sm:block">{tab}</h1>
          </div>
          <div className="flex items-center gap-2">
            <DoctorStatus />
            {hasSupabase() && (
              <button onClick={signOutStaff} className="md:hidden rounded-lg p-2 text-muted hover:text-out" aria-label="Sign out"><LogOut className="h-4 w-4" /></button>
            )}
          </div>
        </div>

        <div className={`${tab === "calendar" ? "p-0" : "p-4 md:p-8 xl:p-10"}`}>
          {!mounted || !scheduleLoaded ? (
            <div className="text-sm text-muted p-4 md:p-8 xl:p-10">Loading…</div>
          ) : tab === "today" ? (
            <Today appts={appts} patch={patchAppt} />
          ) : tab === "schedule" ? (
            <Schedule />
          ) : tab === "calendar" ? (
            <div className="p-4 md:p-8 xl:p-10"><CalendarView appts={appts} /></div>
          ) : tab === "patients" ? (
            <Patients appts={appts} />
          ) : tab === "revenue" ? (
            <Revenue appts={appts} />
          ) : (
            <BugDesk />
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
    <div className="inline-flex items-center gap-2 rounded-full border border-line bg-white px-4 py-2 text-sm">
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
    <div className="flex flex-col gap-3 rounded-2xl border border-line bg-paper p-5 sm:flex-row sm:items-center sm:justify-between">
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
            className={`rounded-full px-4 py-2 text-sm font-medium transition ${mode === o.m ? o.active : "text-muted hover:text-ink"}`}>
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
      <button onClick={() => shift(-1)} title="Previous day" className="rounded-lg border border-line p-2 text-muted hover:bg-line/40 hover:text-ink"><ChevronLeft className="h-[18px] w-[18px]" /></button>
      <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} className="rounded-lg border border-line bg-white px-3 py-2 text-sm font-medium outline-none focus:border-brand" />
      <button onClick={() => shift(1)} title="Next day" className="rounded-lg border border-line p-2 text-muted hover:bg-line/40 hover:text-ink"><ChevronRight className="h-[18px] w-[18px]" /></button>
      {!isToday && <button onClick={() => setDate(todayStr)} className="ml-1 rounded-full bg-brand-tint px-3 py-2 text-xs font-semibold text-brand hover:bg-brand hover:text-white">Today</button>}
    </div>
  );
}
const dateLabel = (date: string) => {
  const d = new Date(date + "T00:00:00");
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) });
};

/* ── TODAY: stats + live queue + walk-in + broadcast ───────────────────────── */
function Today({ appts, patch }: { appts: Appt[]; patch: Patch }) {
  const [date, setDate] = useState(() => ymd(new Date()));
  const isToday = date === ymd(new Date());
  // payment_pending rows are online bookings still awaiting payment — not yet
  // real to the desk. Hidden until the Razorpay webhook flips them to reserved
  // (or the timeout cron cancels them), same as the doctor page.
  const list = apptsForDate(appts, date).filter((a) => a.status !== "payment_pending");
  const active = list.filter((a) => a.status !== "cancelled");
  const inQueue = list.filter((a) => ["reserved", "confirmed", "waiting"].includes(a.status));
  const serving = list.find((a) => a.status === "consulting");
  const next = inQueue[0];
  // Net collected — money that came in then went out (a refunded row) counts
  // toward nothing. dbMarkRefunded keeps paid=true so the refund is traceable;
  // refunded_at is what rollups must subtract.
  const revenue = list.filter((a) => a.paid && a.refundedAt == null).reduce((s, a) => s + a.fee, 0);
  // Cash still owed to the desk today: every non-cancelled unpaid row. Row
  // status payment_pending is excluded — that's an online booking awaiting
  // payment, not cash owed at the counter. The desk reconciles Collected +
  // this against the fee box at close.
  const toCollectList = list.filter((a) => a.status !== "cancelled" && a.status !== "payment_pending" && !a.paid);
  const toCollect = toCollectList.reduce((s, a) => s + a.fee, 0);

  const callNext = () => {
    if (serving) changeStatus(serving.id, "done", serving.status, patch);
    const n = apptsForDate(appts, date).find((a) => ["reserved", "confirmed", "waiting"].includes(a.status));
    if (n) changeStatus(n.id, "consulting", n.status, patch);
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

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Stat label="Appointments" value={String(active.length)} icon={CalendarCog} />
        <Stat label="In queue" value={String(inQueue.length)} icon={Clock} />
        <Stat label="Now serving" value={serving ? `#${serving.token}` : "—"} icon={CircleDot} accent />
        <Stat label="Collected" value={money(revenue)} icon={IndianRupee} />
      </div>

      {isToday && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-line bg-paper px-4 py-2.5 text-sm">
          <span className="font-medium">Collected <b className="text-in">{money(revenue)}</b></span>
          <span className="text-muted">·</span>
          <span className="font-medium">To collect at desk <b className="text-accent">{money(toCollect)}</b>{toCollectList.length > 0 ? ` (${toCollectList.length})` : ""}</span>
          <span className="ml-auto text-xs text-muted">Online payments flip a row to Paid online on their own.</span>
        </div>
      )}

      <div className="grid lg:grid-cols-3 gap-6">
        {/* queue */}
        <div className="lg:col-span-2 rounded-2xl border border-line bg-paper">
          <div className="flex items-center justify-between border-b border-line px-6 py-4">
            <div className="flex items-center gap-2">
              <h2 className="font-semibold">{isToday ? "Live queue" : "Queue"}</h2>
              {isToday && next && <span className="text-xs text-muted">next up: <b className="text-ink">#{next.token} {next.name}</b></span>}
            </div>
            {isToday && (
              <button onClick={callNext} className="inline-flex items-center gap-1.5 rounded-full bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-dark">
                <PhoneCall className="h-4 w-4" /> Call next
              </button>
            )}
          </div>
          <ul className="divide-y divide-line">
            {list.map((a) => <QueueRow key={a.id} a={a} patch={patch} />)}
            {list.length === 0 && <li className="px-6 py-10 text-center text-sm text-muted">No appointments on this date.</li>}
          </ul>
        </div>

        {/* side */}
        <div className="space-y-6">
          <WalkIn />
          <Broadcast appts={appts} />
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
  waiting: { label: "Waiting", cls: "bg-accent-tint text-accent" },
  consulting: { label: "In consult", cls: "bg-in/15 text-in" },
  done: { label: "Done", cls: "bg-muted/15 text-muted" },
  cancelled: { label: "Cancelled", cls: "bg-out/10 text-out line-through" },
  payment_pending: { label: "Awaiting payment", cls: "bg-accent-tint text-accent" },
};

function QueueRow({ a, patch }: { a: Appt; patch: Patch }) {
  const S = sourceMeta[a.source];
  const cancel = () => {
    if (!window.confirm(`Cancel Token #${a.token} (${a.name})? This sends them a WhatsApp cancellation notice right away and can't be undone.`)) return;
    changeStatus(a.id, "cancelled", a.status, patch);
  };
  // Refunds are manual by clinic policy (see lib/refunds.ts) — this just
  // records a refund already issued from the Razorpay dashboard, so the desk
  // has a way to close the loop instead of a paid+cancelled row sitting
  // there forever with no record of the money going back out.
  const recordRefund = () => {
    const refundId = window.prompt(`Razorpay refund ID for Token #${a.token} (${a.name})?\n\nOnly enter this after the refund is already issued from the Razorpay dashboard.`);
    if (!refundId || !refundId.trim()) return;
    const prevRefundedAt = a.refundedAt;
    patch(a.id, { refundedAt: Date.now(), refundId: refundId.trim() });
    fetch("/api/appointments/refund", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: a.id, refundId: refundId.trim() }),
    })
      .then((res) => { if (!res.ok) throw new Error(String(res.status)); })
      .catch((err) => {
        console.error("admin: could not record refund", err);
        patch(a.id, { refundedAt: prevRefundedAt, refundId: a.refundId });
        window.alert("Could not save the refund record — please try again.");
      });
  };
  return (
    <li className={`flex items-center gap-3 px-6 py-3.5 ${a.status === "consulting" ? "bg-in/[0.04]" : ""}`}>
      <div className={`grid h-10 w-10 shrink-0 place-items-center rounded-lg font-mono text-sm font-semibold ${a.status === "done" ? "bg-muted/10 text-muted" : "bg-brand text-white"}`}>{a.token}</div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{a.name}</span>
          {a.patientCode && <span className="shrink-0 font-mono text-[11px] text-muted">{a.patientCode}</span>}
          {a.claimType === "returning_unverified" && (
            <span title="Self-declared returning patient, not matched against any record" className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700">Verify at counter</span>
          )}
          {a.claimType === "review_free" && (
            <span title="Self-declared free review visit, within 10 days of a prior appointment" className="shrink-0 rounded-full bg-in/15 px-2 py-0.5 text-[11px] font-medium text-in">Free review</span>
          )}
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${statusMeta[a.status].cls}`}>{statusMeta[a.status].label}</span>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted">
          <span>{fmt(a.time)}</span> · <span className="inline-flex items-center gap-1"><S.icon className="h-3 w-3" />{S.label}</span>{ageGenderLabel(a)}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {/* Payment state + cash collection. Named in the audit: the desk had
            no way to tell "paid online vs collect at the desk", cash could
            only be recorded after a row hit done, and a mis-tap could undo a
            Razorpay collection. Cash reads and writes happen here; Razorpay
            and refunded rows are static (refunds are the only reversal). */}
        {a.refundedAt != null ? (
          <span title={`Refunded${a.refundId ? " · " + a.refundId : ""}`} className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700">Refunded</span>
        ) : a.claimType === "review_free" ? (
          <span title="Free review visit, nothing to collect" className="shrink-0 rounded-full bg-muted/10 px-2.5 py-0.5 text-[11px] font-medium text-muted">Free</span>
        ) : a.paid && a.paidVia === "razorpay" && a.status === "cancelled" ? (
          <button onClick={recordRefund} title="Record a refund already issued from the Razorpay dashboard" className="shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700 hover:bg-amber-100">Mark refunded</button>
        ) : a.paid && a.paidVia === "razorpay" ? (
          <span title="Paid online via payment link. Cannot be un-marked at the desk." className="shrink-0 rounded-full bg-in/15 px-2 py-0.5 text-[11px] font-medium text-in">Paid online</span>
        ) : a.paid ? (
          <button onClick={() => changePaid(a.id, a, patch)} title="Cash collected. Tap to mark unpaid if this was a mistake." className="shrink-0 rounded-full bg-in/15 px-2.5 py-0.5 text-[11px] font-medium text-in hover:bg-in/25">Paid · cash</button>
        ) : a.status !== "cancelled" ? (
          <button onClick={() => changePaid(a.id, a, patch)} title={`Collect ${money(a.fee)} in cash`} className="shrink-0 rounded-full border border-dashed border-out/40 px-2.5 py-0.5 text-[11px] font-medium text-out hover:bg-out/5">Collect</button>
        ) : null}
        {["reserved", "confirmed", "waiting"].includes(a.status) && (
          <button onClick={() => changeStatus(a.id, "consulting", a.status, patch)} title="Start consult" className="rounded-lg border border-line p-2 text-brand hover:bg-brand-tint"><Play className="h-[18px] w-[18px]" /></button>
        )}
        {a.status === "consulting" && (
          <button onClick={() => changeStatus(a.id, "done", a.status, patch)} title="Mark done" className="rounded-lg border border-line p-2 text-in hover:bg-in/10"><Check className="h-[18px] w-[18px]" /></button>
        )}
        {a.status !== "done" && a.status !== "cancelled" && (
          <button onClick={cancel} title="Cancel" className="rounded-lg border border-line p-2 text-muted hover:text-out hover:bg-out/10"><X className="h-[18px] w-[18px]" /></button>
        )}
      </div>
    </li>
  );
}

function WalkIn() {
  const [f, setF] = useState({ name: "", phone: "", age: 0 as number, gender: "" as "" | "M" | "F" });
  const [done, setDone] = useState<null | number>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!f.name.trim()) return;
    try {
      const a = await addWalkInAny({ ...f, gender: f.gender || null });
      setDone(a.token); setF({ name: "", phone: "", age: 0, gender: "" });
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
        <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Patient name" className="w-full rounded-lg border border-line bg-white px-3 py-2.5 text-sm outline-none focus:border-brand" />
        <input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="Phone (optional)" inputMode="tel" className="w-full rounded-lg border border-line bg-white px-3 py-2.5 text-sm outline-none focus:border-brand" />
        <input type="number" value={f.age || ""} onChange={(e) => setF({ ...f, age: e.target.value ? +e.target.value : 0 })} placeholder="Age" min="1" max="150" required className="w-full rounded-lg border border-line bg-white px-3 py-2.5 text-sm outline-none focus:border-brand" />
        <select value={f.gender} onChange={(e) => setF({ ...f, gender: e.target.value as "" | "M" | "F" })} className="w-full rounded-lg border border-line bg-white px-3 py-2.5 text-sm outline-none focus:border-brand">
          <option value="">Gender (optional)</option>
          <option value="M">Male</option>
          <option value="F">Female</option>
        </select>
        <button className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-brand py-3 text-sm font-semibold text-white hover:bg-brand-dark"><Plus className="h-4 w-4" /> Add to queue</button>
      </form>
      {done && <div className="mt-2 rounded-lg bg-in/10 px-3 py-2 text-sm text-in">Added · token <b>#{done}</b> issued.</div>}
    </div>
  );
}

// The states a queued patient can still be messaged about. Consulting are in
// the room with the doctor; done/cancelled are gone.
const broadcastStatuses: ApptStatus[] = ["reserved", "confirmed", "waiting"];

function nextSessionAfter(from: string): string {
  const d = new Date(from + "T00:00:00");
  for (let i = 0; i < 30; i++) {
    d.setDate(d.getDate() + 1);
    if (windowsFor(d).length > 0) return ymd(d);
  }
  return ymd(d);
}

function Broadcast({ appts }: { appts: Appt[] }) {
  const [scope, setScope] = useState<"today" | "next">("today");
  const [mins, setMins] = useState(30);
  const [msg, setMsg] = useState("");
  const [sel, setSel] = useState<Record<string, boolean>>({});
  const [selDate, setSelDate] = useState("");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ note: string; recipients?: { name: string; ok: boolean }[] } | null>(null);
  // Which send path the next broadcast uses: "reminder" (structured template,
  // set by the Reminder preset) or "notice" (free text). Editing the message
  // box falls back to "notice" so the desk always knows what it's sending.
  const [kind, setKind] = useState<"notice" | "reminder">("notice");

  const today = ymd(new Date());
  const next = nextSessionAfter(today);
  const scopeDate = scope === "today" ? today : next;

  const candidates = appts.filter((a) => a.date === scopeDate && broadcastStatuses.includes(a.status) && a.phone);
  // Default-check every candidate when the scope's date changes. Deliberately
  // not keyed on the candidates themselves: the 45s realtime poll reloads
  // appts constantly, and it must never wipe a manual uncheck.
  if (selDate !== scopeDate) {
    setSelDate(scopeDate);
    setSel(Object.fromEntries(candidates.map((a) => [a.id, true])));
  }
  const selCount = candidates.filter((a) => sel[a.id]).length;
  const toggle = (id: string) => setSel((s) => ({ ...s, [id]: !s[id] }));

  const presets: { key: string; label: string; scope: "today" | "next"; kind: "notice" | "reminder"; make: () => string }[] = [
    { key: "late", label: "Running late", scope: "today", kind: "notice", make: () => `Dr. Ramachandra is running about ${mins} minutes late today. Sorry for the wait.` },
    { key: "remind", label: "Reminder for the next session", scope: "next", kind: "reminder", make: () => `Reminder: you have an appointment at Ramachandra Ortho Care on ${dateLabel(next)}. Kindly be on time. To reschedule or cancel, just reply on this chat.` },
    { key: "closed", label: "Clinic closed today", scope: "today", kind: "notice", make: () => "The clinic is closed today. We are sorry for the inconvenience and will help you rebook." },
  ];
  const applyPreset = (p: { scope: "today" | "next"; kind: "notice" | "reminder"; make: () => string }) => {
    setScope(p.scope);
    setKind(p.kind);
    setMsg(p.make());
  };

  const send = async () => {
    if (!selCount || !msg.trim()) return;
    setSending(true);
    try {
      if (hasSupabase()) {
        const res = await fetch("/api/admin/broadcast", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ date: scopeDate, ids: candidates.filter((a) => sel[a.id]).map((a) => a.id), message: msg.trim(), kind }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || "send failed");
        const note = data.failed === data.attempted
          ? data.kind === "reminder"
            ? "None delivered. The reminder template may not be approved or set in Vercel yet."
            : "None delivered. Check the WhatsApp template setup in the server logs."
          : data.failed
          ? `Delivered ${data.attempted - data.failed} of ${data.attempted}. ${data.failed} did not deliver.`
          : data.kind === "reminder"
          ? `Delivered to ${data.attempted} patient${data.attempted === 1 ? "" : "s"} via the reminder template.`
          : `Delivered to ${data.attempted} patient${data.attempted === 1 ? "" : "s"}.`;
        setResult({ note, recipients: data.recipients });
      } else {
        const rcpts = candidates.filter((a) => sel[a.id]).map((a) => ({ name: a.name, ok: true }));
        setResult({ note: `Simulated, sent to ${rcpts.length} patient${rcpts.length === 1 ? "" : "s"} (demo mode, no WhatsApp).`, recipients: rcpts });
      }
    } catch (err) {
      console.error("admin: broadcast failed", err);
      const reason = err instanceof Error && err.message ? err.message : "unknown error";
      setResult({ note: `Could not send. ${reason}` });
    } finally {
      setSending(false);
      setTimeout(() => setResult(null), 8000);
    }
  };

  return (
    <div className="rounded-2xl border border-line bg-paper p-5">
      <h2 className="flex items-center gap-2 font-semibold"><Megaphone className="h-4 w-4 text-accent" /> Broadcast</h2>
      <p className="mt-1 text-xs text-muted">Pick who to reach, tap a preset or write your own, then send. Free text is delivered as the clinic notice template. The Reminder preset instead uses the structured appointment reminder template (each patient&apos;s own time + a View Appointment button) once it&apos;s approved, and falls back to this text until then.</p>

      <div className="mt-3 flex rounded-full border border-line bg-white p-0.5">
        {([["today", "Today"], ["next", "Next session"]] as const).map(([k, label]) => (
          <button key={k} onClick={() => setScope(k)} className={`flex-1 rounded-full px-3 py-1.5 text-xs font-medium ${scope === k ? "bg-brand text-white" : "text-muted hover:text-ink"}`}>{label}</button>
        ))}
      </div>
      <p className="mt-1.5 text-xs text-muted"><b className="text-ink">{dateLabel(scopeDate)}</b>, {candidates.length} patient{candidates.length === 1 ? "" : "s"} with a phone number on file.</p>

      {candidates.length > 0 ? (
        <ul className="mt-2 max-h-72 space-y-1 overflow-y-auto rounded-xl border border-line bg-white p-2">
          {candidates.map((a) => (
            <li key={a.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-line/40">
              <input type="checkbox" checked={!!sel[a.id]} onChange={() => toggle(a.id)} className="h-4 w-4 shrink-0 accent-[var(--color-brand)]" />
              <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-md font-mono text-[11px] font-semibold ${a.status === "waiting" ? "bg-accent-tint text-accent" : "bg-brand-tint text-brand"}`}>{a.token}</span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{a.name}</div>
                <div className="truncate text-[11px] text-muted">{fmt(a.time)}, {sourceMeta[a.source].label} · +91 …{a.phone.slice(-4)}</div>
              </div>
              <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${statusMeta[a.status].cls}`}>{statusMeta[a.status].label}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="mt-2 rounded-xl border border-dashed border-line bg-line/20 px-4 py-5 text-center text-xs text-muted">
          No one in {scope === "today" ? "today's" : "the next session's"} queue has a phone number to message.
          <button onClick={() => setScope(scope === "today" ? "next" : "today")} className="mt-2 block w-full rounded-lg border border-line bg-white py-1.5 font-medium text-brand hover:bg-brand-tint">{scope === "today" ? "Message the next session instead" : "Message today's queue instead"}</button>
        </div>
      )}

      <div className="mt-3 grid grid-cols-1 gap-1.5">
        <div className="flex items-center gap-1.5">
          <button disabled={sending} onClick={() => applyPreset(presets[0])} className="flex-1 rounded-lg border border-line py-2.5 text-sm font-medium hover:border-accent/50 disabled:opacity-50">Running late</button>
          <input type="number" value={mins} onChange={(e) => setMins(+e.target.value)} className="w-16 rounded-lg border border-line bg-white px-2 py-2 text-sm" />
          <span className="text-xs text-muted">min</span>
        </div>
        <button disabled={sending} onClick={() => applyPreset(presets[1])} className="rounded-lg border border-line py-2.5 text-sm font-medium hover:border-accent/50 disabled:opacity-50">{presets[1].label}</button>
        <button disabled={sending} onClick={() => applyPreset(presets[2])} className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-out/30 py-2.5 text-sm font-medium text-out hover:bg-out/5 disabled:opacity-50"><TriangleAlert className="h-4 w-4" /> {presets[2].label}</button>
      </div>

      <textarea value={msg} onChange={(e) => { setMsg(e.target.value.slice(0, 400)); setKind("notice"); }} rows={3} placeholder="Type a message, or tap a preset above to fill this in…" className="mt-3 w-full rounded-xl border border-line bg-white px-3 py-2.5 text-sm outline-none focus:border-brand" />
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted">{msg.length}/400</span>
        <button onClick={send} disabled={sending || selCount === 0 || !msg.trim()} className="inline-flex items-center gap-1.5 rounded-full bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-dark disabled:opacity-40">
          <Send className="h-3.5 w-3.5" /> {sending ? "Sending…" : `Send to ${selCount}`}
        </button>
      </div>

      {result && (
        <div className="mt-3 rounded-xl bg-brand-tint px-3 py-2.5 text-xs text-brand">
          <div>{result.note}</div>
          {result.recipients && result.recipients.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {result.recipients.map((r, i) => (
                <span key={i} className={`inline-flex items-center gap-1 rounded-full bg-white px-2 py-0.5 text-[11px] font-medium ${r.ok ? "text-in" : "text-out"}`}>{r.ok ? "✓" : "✕"} {r.name}</span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, icon: Icon, accent }: { label: string; value: string; icon: typeof Users; accent?: boolean }) {
  return (
    <div className={`rounded-2xl border p-5 ${accent ? "border-brand/30 bg-brand text-white" : "border-line bg-paper"}`}>
      <div className={`flex items-center gap-2 text-xs ${accent ? "text-white/80" : "text-muted"}`}><Icon className="h-4 w-4" /> {label}</div>
      <div className="mt-2.5 font-display text-4xl leading-none">{value}</div>
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
    <div className="max-w-4xl space-y-4">
      <div className="rounded-2xl border border-line bg-paper p-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-semibold">Weekly consulting hours</h2>
            <p className="text-xs text-muted">This drives the live availability on the website and the WhatsApp bot. Mon-Sat share the same OPD hours by default; Sunday is the weekly holiday.</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={reset} className="inline-flex items-center gap-1.5 rounded-full border border-line px-4 py-2 text-sm font-medium text-ink hover:bg-line/40"><RotateCcw className="h-3.5 w-3.5" /> Reset to default</button>
            <button onClick={save} className="rounded-full bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-dark">Save</button>
          </div>
        </div>
        <div className="mt-4 divide-y divide-line">
          {[1, 2, 3, 4, 5, 6, 0].map((d) => (
            <div key={d} className="flex items-start gap-5 py-4">
              <div className="w-16 pt-1.5 text-sm font-semibold text-ink">{DAY_LABELS[d]}</div>
              <div className="flex-1 space-y-2">
                {weekly[d].length === 0 && <div className="py-1.5 text-sm text-muted">Closed</div>}
                {weekly[d].map((w, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input type="time" value={w.start} onChange={(e) => setWin(d, i, "start", e.target.value)} className="rounded-lg border border-line bg-white px-3 py-2 text-sm" />
                    <span className="text-muted">-</span>
                    <input type="time" value={w.end} onChange={(e) => setWin(d, i, "end", e.target.value)} className="rounded-lg border border-line bg-white px-3 py-2 text-sm" />
                    <button onClick={() => rmWin(d, i)} className="rounded-lg p-2 text-muted hover:text-out"><X className="h-[18px] w-[18px]" /></button>
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
      <SlotToggles weekly={weekly} ex={ex} setEx={setEx} />
    </div>
  );
}

// One-line human summary of a date's exception, for the overrides list.
// A date can carry more than one kind of edit (closed + disabled, or custom
// hours + disabled), so each is listed in turn instead of a single hardcoded
// label.
const exceptionSummary = (e: Exception): string => {
  const parts: string[] = [];
  if (e.closed) parts.push(`Closed${e.note ? ` · ${e.note}` : ""}`);
  if (e.windows?.length) parts.push(`Hours: ${e.windows.map((w) => `${fmt(w.start)} to ${fmt(w.end)}`).join(", ")}`);
  if (e.disabled?.length) parts.push(`Blocked: ${e.disabled.map(fmt).join(", ")}`);
  return parts.join(" · ");
};

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
    <div className="rounded-2xl border border-line bg-paper p-6">
      <h2 className="font-semibold">Holidays &amp; date overrides</h2>
      <p className="text-xs text-muted">Mark a specific date closed (festival, doctor leave). Overrides the weekly hours above for just that date. Remember to hit Save.</p>

      <div className="mt-4 space-y-2">
        {dates.length === 0 && <div className="text-sm text-muted">No overrides set.</div>}
        {dates.map((d) => (
          <div key={d} className="flex items-center gap-2 rounded-lg border border-line bg-white px-3 py-2 text-sm">
            <CalendarOff className="h-4 w-4 shrink-0 text-out" />
            <span className="font-medium">{dateLabel(d)}</span>
            <span className="text-muted truncate">{exceptionSummary(ex[d])}</span>
            <button onClick={() => remove(d)} title="Remove" className="ml-auto shrink-0 rounded-lg p-1 text-muted hover:text-out"><X className="h-4 w-4" /></button>
          </div>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)} className="rounded-lg border border-line bg-white px-3 py-2 text-sm" />
        <input value={newNote} onChange={(e) => setNewNote(e.target.value)} placeholder="Note (optional, e.g. Diwali)" className="min-w-[10rem] flex-1 rounded-lg border border-line bg-white px-3 py-2 text-sm outline-none focus:border-brand" />
        <button onClick={add} disabled={!newDate} className="inline-flex items-center gap-1 rounded-lg border border-line px-4 py-2 text-sm font-medium text-brand hover:bg-brand-tint disabled:opacity-50"><Plus className="h-3.5 w-3.5" /> Add</button>
      </div>
    </div>
  );
}

// Per-day slot blocks. The admin picks a date and taps the day's slots to
// block or unblock them; a blocked time accepts no new bookings from any
// surface (the filter lives in allSlotsFor). Existing bookings on a blocked
// time stay as they are. Edits land in the same `ex` map the weekly-hours
// editor and ExceptionsEditor share, so the existing Save persists them.
function SlotToggles({ weekly, ex, setEx }: { weekly: WeeklyHours; ex: Record<string, Exception>; setEx: Dispatch<SetStateAction<Record<string, Exception>>> }) {
  const today = ymd(new Date());
  const [pick, setPick] = useState(today);
  const blocked = new Set(ex[pick]?.disabled ?? []);

  // The slots this date would offer right now, from the live editor state, so
  // edits to the weekly hours above or a holiday override re-map the pills.
  // For today, hide times already past the booking cutoff — they mirror what
  // the server would refuse.
  const slots = useMemo(() => {
    const s = allSlotsFor(new Date(pick + "T00:00:00"), { weekly, exceptions: ex, override: null });
    return pick === ymd(new Date())
      ? s.filter((t) => !isPastLeadTime(pick, t, new Date()))
      : s;
  }, [pick, weekly, ex]);

  // Always build a fresh exception object — the value objects in `ex` alias
  // the shared schedule singleton, so an in-place edit would dirty production
  // before Save. Removing the last blocked time also clears the `disabled`
  // key, and drops the whole date entry if nothing else remains.
  const flip = (t: string) =>
    setEx((e) => {
      const cur = e[pick];
      const has = (cur?.disabled ?? []).includes(t);
      const next = has
        ? (cur?.disabled ?? []).filter((x) => x !== t)
        : [...(cur?.disabled ?? []), t].sort();
      if (next.length === 0) {
        if (!cur) return e;
        const { disabled, ...rest } = cur;
        if (Object.keys(rest).length === 0) {
          const n = { ...e };
          delete n[pick];
          return n;
        }
        return { ...e, [pick]: rest };
      }
      return { ...e, [pick]: { ...cur, disabled: next } };
    });

  return (
    <div className="rounded-2xl border border-line bg-paper p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold">Block times for a day</h2>
          <p className="text-xs text-muted">Tap a slot to block or unblock it for that date. A blocked time is refused everywhere, the website and WhatsApp. Bookings already on a blocked time stay as they are. Remember to hit Save.</p>
        </div>
        <input type="date" value={pick} min={today} onChange={(e) => setPick(e.target.value)} className="rounded-lg border border-line bg-white px-3 py-2 text-sm" />
      </div>

      <div className="mt-4">
        <p className="text-sm text-ink">{dateLabel(pick)}</p>
        {slots.length === 0 ? (
          <div className="mt-2 rounded-lg border border-dashed border-line bg-bone/60 px-3 py-4 text-center text-sm text-muted">
            {ex[pick]?.closed ? "This date is marked closed." : "No bookable slots this day."}
          </div>
        ) : (
          <>
            <div className="mt-3 flex flex-wrap gap-2">
              {slots.map((t) => {
                const off = blocked.has(t);
                return (
                  <button
                    key={t}
                    onClick={() => flip(t)}
                    aria-pressed={off}
                    title={off ? "Tap to unblock" : "Tap to block"}
                    className={`rounded-full px-4 py-2 text-xs font-medium transition ${off ? "bg-out text-white" : "border border-line bg-white text-ink hover:bg-line/40"}`}
                  >
                    {fmt(t)}
                  </button>
                );
              })}
            </div>
            <p className="mt-3 text-xs text-muted">
              {slots.length - blocked.size} of {slots.length} slots open this day.
            </p>
          </>
        )}
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
      // Dedup by phone only — it's the one reliable identity signal. Without a
      // phone on file, two different people can share a name (e.g. two walk-ins
      // named "Ramesh"), so each such visit stays its own row rather than
      // silently merging into one patient.
      const k = a.phone ? `p:${a.phone}` : `a:${a.id}`;
      const cur = by.get(k);
      if (cur) cur.visits++;
      else by.set(k, { name: a.name, phone: a.phone, visits: 1, last: a });
    }
    return [...by.values()].filter((p) => (p.name + p.phone).toLowerCase().includes(q.toLowerCase()));
  }, [appts, q]);
  return (
    <div className="space-y-4">
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search patients…" className="w-full max-w-md rounded-lg border border-line bg-white px-3.5 py-2.5 text-sm outline-none focus:border-brand" />
      <div className="overflow-hidden rounded-2xl border border-line bg-paper">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line bg-bone/60 text-left text-[11px] uppercase tracking-wide text-muted">
              <th className="px-6 py-3.5 font-semibold">Patient</th>
              <th className="px-6 py-3.5 font-semibold">Phone</th>
              <th className="px-6 py-3.5 font-semibold">Visits</th>
              <th className="px-6 py-3.5 font-semibold">Last visit</th>
              <th className="px-6 py-3.5 text-right font-semibold">Notify</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {list.map((p) => (
              <tr key={p.last.id} className="transition hover:bg-bone/40">
                <td className="px-6 py-3">
                  <div className="flex items-center gap-3">
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand-tint text-sm font-semibold text-brand">{p.name[0]}</span>
                    <div className="min-w-0">
                      <div className="truncate font-medium">{p.name}</div>
                      {p.last.patientCode && <div className="font-mono text-[11px] text-muted">{p.last.patientCode}</div>}
                    </div>
                  </div>
                </td>
                <td className="px-6 py-3 text-muted">{p.phone || <span className="text-muted/60">no phone</span>}{ageGenderLabel(p.last)}</td>
                <td className="px-6 py-3">
                  <span className="rounded-full bg-brand-tint px-2.5 py-1 text-xs font-medium text-brand">{p.visits} visit{p.visits > 1 ? "s" : ""}</span>
                </td>
                <td className="px-6 py-3 text-ink">{dateLabel(p.last.date)}</td>
                <td className="px-6 py-3 text-right">{p.phone && <InviteButton phone={p.phone} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {list.length === 0 && <div className="px-6 py-10 text-center text-sm text-muted">No patients.</div>}
      </div>
      <p className="text-xs text-muted">Basic patient records (beta). Full history, prescriptions and reports come later.</p>
    </div>
  );
}

// Manual nudge onto WhatsApp for a patient who's only ever booked via the
// website or as a walk-in — sends clinic_welcome_booking_link once per click.
function InviteButton({ phone }: { phone: string }) {
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const invite = async () => {
    setState("sending");
    try {
      if (hasSupabase()) {
        const res = await fetch("/api/admin/whatsapp-invite", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phone }),
        });
        if (!res.ok) throw new Error();
      }
      setState("sent");
    } catch {
      setState("error");
    } finally {
      setTimeout(() => setState("idle"), 4000);
    }
  };
  return (
    <button
      onClick={invite}
      disabled={state === "sending"}
      title="Send WhatsApp invite"
      className="shrink-0 rounded-lg border border-line p-1.5 text-muted hover:border-brand/50 hover:text-brand disabled:opacity-50"
    >
      {state === "sent" ? <Check className="h-4 w-4 text-in" /> : state === "error" ? <X className="h-4 w-4 text-out" /> : <MessageCircle className="h-4 w-4" />}
    </button>
  );
}

/* ── REVENUE ───────────────────────────────────────────────────────────────── */
function Revenue({ appts }: { appts: Appt[] }) {
  const [date, setDate] = useState(() => ymd(new Date()));
  const isToday = date === ymd(new Date());
  const list = apptsForDate(appts, date).filter((a) => a.paid);
  // Net, not gross: a refunded row's money came in then went out, so it must
  // be subtracted (dbMarkRefunded's docstring rule), not counted as collected.
  const collected = list.filter((a) => a.refundedAt == null);
  const total = collected.reduce((s, a) => s + a.fee, 0);
  const bySource = (["website", "whatsapp", "walkin"] as Source[]).map((s) => ({
    s, n: collected.filter((a) => a.source === s).length,
  }));
  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-lg">{isToday ? "Today" : dateLabel(date)}</h2>
        <DateNav date={date} setDate={setDate} />
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <Stat label="Collected" value={money(total)} icon={IndianRupee} accent />
        <Stat label="Consults paid" value={String(collected.length)} icon={Check} />
        {bySource.map((b) => (
          <Stat key={b.s} label={sourceMeta[b.s].label} value={String(b.n)} icon={sourceMeta[b.s].icon} />
        ))}
      </div>
      <div className="overflow-hidden rounded-2xl border border-line bg-paper">
        <div className="flex items-center justify-between border-b border-line px-6 py-4">
          <div className="font-semibold">Collections {isToday ? "today" : `on ${dateLabel(date)}`}</div>
          <div className="text-sm font-medium text-in">{money(total)} net collected</div>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line bg-bone/60 text-left text-[11px] uppercase tracking-wide text-muted">
              <th className="px-6 py-3 font-semibold">Token</th>
              <th className="px-6 py-3 font-semibold">Patient</th>
              <th className="px-6 py-3 font-semibold">Source</th>
              <th className="px-6 py-3 text-right font-semibold">Amount</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {list.map((a) => {
              const S = sourceMeta[a.source];
              return (
                <tr key={a.id} className="transition hover:bg-bone/40">
                  <td className="px-6 py-3 font-mono text-xs text-muted">#{a.token}</td>
                  <td className="px-6 py-3">
                    <span className="font-medium">{a.name}</span>
                    {a.refundedAt != null && <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700">Refunded</span>}
                  </td>
                  <td className="px-6 py-3"><span className="inline-flex items-center gap-1.5 text-muted"><S.icon className="h-3.5 w-3.5" />{S.label}</span></td>
                  <td className={`px-6 py-3 text-right font-medium ${a.refundedAt != null ? "text-muted line-through" : ""}`}>{money(a.fee)}</td>
                </tr>
              );
            })}
            {list.length === 0 && (
              <tr><td colSpan={4} className="px-6 py-10 text-center text-sm text-muted">No collections on this date.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted">Beta: consultation fees only. Procedures, UPI reconciliation and trends come later.</p>
    </div>
  );
}

/* ── Bug desk ─────────────────────────────────────────────────────────────── */
type BugRow = {
  fingerprint: string;
  source: string;
  message: string;
  severity: "critical" | "warning";
  count: number;
  first_seen: string;
  last_seen: string;
  alerted_at: string | null;
  resolved: boolean;
};

// Same IST short format the bug desk emails use (client-side mirror of
// fmtLastSeen in lib/bugdesk.ts, which is server-only).
const bugLastSeen = (iso: string) =>
  new Date(iso).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  });

function BugDesk() {
  const [rows, setRows] = useState<BugRow[]>([]);
  const [filter, setFilter] = useState<"all" | "critical" | "warning">("all");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const load = () => {
    setLoading(true);
    fetch("/api/admin/bugdesk")
      .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
      .then((d) => { setRows(d.rows ?? []); setLoadError(false); })
      .catch(() => setLoadError(true))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  // Optimistic flip, refetch on failure so the toggle can't lie to the desk.
  const toggle = (row: BugRow) => {
    const next = !row.resolved;
    setRows((prev) => prev.map((r) => (r.fingerprint === row.fingerprint ? { ...r, resolved: next } : r)));
    fetch("/api/admin/bugdesk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fingerprint: row.fingerprint, resolved: next }),
    }).catch(() => load());
  };

  const open = rows.filter((r) => (filter === "all" ? true : r.severity === filter));
  const openCount = rows.filter((r) => !r.resolved).length;
  const criticalOpen = rows.filter((r) => !r.resolved && r.severity === "critical").length;

  return (
    <div className="max-w-4xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-lg">
          Bug desk
          {openCount > 0 && (
            <span className={`ml-2 rounded-full px-2.5 py-1 text-xs font-medium ${criticalOpen ? "bg-accent-tint text-accent" : "bg-brand-tint text-brand"}`}>
              {criticalOpen > 0 ? `${criticalOpen} critical · ${openCount} open` : `${openCount} open`}
            </span>
          )}
        </h2>
        <div className="flex gap-1.5">
          {(["all", "critical", "warning"] as const).map((f) => (
            <button key={f} onClick={() => setFilter(f)}
              className={`rounded-full px-4 py-2 text-xs font-medium capitalize transition ${filter === f ? "bg-brand text-white" : "border border-line bg-paper text-muted hover:text-ink"}`}>
              {f === "all" ? "All" : f}
            </button>
          ))}
        </div>
      </div>

      {loadError && !rows.length && <p className="text-sm text-out">Couldn&rsquo;t load the bug desk. Refresh to retry.</p>}
      {loading && <p className="text-sm text-muted">Loading&hellip;</p>}

      {!loading && open.length === 0 ? (
        <div className="rounded-2xl border border-line bg-paper px-6 py-10 text-center text-sm text-muted">
          {loadError ? "Bug desk unavailable." : filter === "all" ? "No issues logged. Quiet is good." : `No ${filter} issues.`}
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-line bg-paper">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-bone/60 text-left text-[11px] uppercase tracking-wide text-muted">
                <th className="px-6 py-3.5 font-semibold">Severity</th>
                <th className="px-6 py-3.5 font-semibold">Issue</th>
                <th className="px-6 py-3.5 font-semibold">Last seen</th>
                <th className="px-6 py-3.5 text-right font-semibold">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {open.map((r) => (
                <tr key={r.fingerprint} className={`transition hover:bg-bone/40 ${r.resolved ? "opacity-60" : ""}`}>
                  <td className="px-6 py-3.5">
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${r.severity === "critical" ? "bg-accent-tint text-accent" : "bg-brand-tint text-brand"}`}>
                      {r.severity === "critical" ? "Critical" : "Warning"}
                    </span>
                    <div className="mt-1 font-mono text-xs text-muted">{r.source}</div>
                  </td>
                  <td className="px-6 py-3.5">
                    <p className="break-words">{r.message}</p>
                    <p className="mt-1 text-xs text-muted">
                      {r.count > 1 ? `${r.count} occurrences` : "Once"}
                      {r.count > 1 && <> &middot; first {bugLastSeen(r.first_seen)}</>}
                      {r.alerted_at && <> &middot; <span className="text-brand">alerted</span></>}
                    </p>
                  </td>
                  <td className="whitespace-nowrap px-6 py-3.5 text-muted">{bugLastSeen(r.last_seen)}</td>
                  <td className="px-6 py-3.5 text-right">
                    {r.resolved && <span className="mr-2.5 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700">Resolved</span>}
                    <button onClick={() => toggle(r)}
                      className={`shrink-0 rounded-lg border border-line px-3.5 py-1.5 text-xs font-medium transition ${r.resolved ? "text-muted hover:text-ink" : "text-ink hover:bg-brand-tint/60"}`}>
                      {r.resolved ? "Reopen" : "Resolve"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-muted">Critical errors email the desk instantly (once per hour per issue); everything surfaces in the 6-hourly digest until resolved. An issue that keeps recurring keeps its count climbing.</p>
    </div>
  );
}
