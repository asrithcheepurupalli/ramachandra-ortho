"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  ArrowLeft, CalendarDays, Clock, User, Ticket, Search, XCircle, PencilLine, Wallet,
} from "lucide-react";
import { clinic, type Lang } from "@/clinic.config";
import { tr, langLabels } from "@/lib/i18n";
import { allSlotsFor, ymd, fmt, weekdayName, BOOKING_LEAD_MIN } from "@/lib/schedule";
import {
  activeAppointmentsByPhone, cancelBooking, rescheduleBooking, togglePaid,
  hydrateSchedule, takenSlots, type Appt,
} from "@/lib/store";
import { hasSupabase } from "@/lib/supabase";

const toMin = (t: string) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
type Tr = (k: string, v?: Record<string, string | number>) => string;
type DayOpt = { date: string; d: Date; slots: string[]; taken: string[]; closingSoon?: boolean };

function MyAppointmentInner() {
  const params = useSearchParams();
  const [lang, setLang] = useState<Lang>("en");
  const t: Tr = (k, v) => tr(lang, k, v);

  const [phone, setPhone] = useState("");
  const [appts, setAppts] = useState<Appt[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  const search = async (p: string) => {
    if (!p.trim()) return;
    setLoading(true); setErr(""); setAppts(null);
    try {
      if (hasSupabase()) {
        const res = await fetch("/api/appointments/lookup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phone: p.trim() }),
        });
        const data = await res.json();
        if (!res.ok) { setErr(data.error ?? t("myappt.error")); return; }
        setAppts(data.appointments as Appt[]);
      } else {
        hydrateSchedule();
        setAppts(activeAppointmentsByPhone(p.trim()));
      }
    } catch {
      setErr(t("myappt.error"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const pre = params?.get("phone");
    const paidId = params?.get("paid");
    if (pre) {
      setPhone(pre);
      search(pre);
      // Razorpay's callback_url redirect can land a second or two before the
      // webhook that actually flips `paid` finishes — one extra silent
      // re-fetch shortly after makes the return trip feel instant instead of
      // stale, without this page being the source of truth for the flag.
      if (paidId) setTimeout(() => search(pre), 1500);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onCancelled = (id: string) => setAppts((prev) => (prev ? prev.filter((a) => a.id !== id) : prev));
  const updateAppt = (updated: Appt) =>
    setAppts((prev) => (prev ? prev.map((a) => (a.id === updated.id ? updated : a)) : prev));

  return (
    <main className="mx-auto w-full max-w-lg px-5 pb-16 pt-6">
      <div className="flex items-center justify-between gap-3">
        <Link href="/" className="press inline-flex min-w-0 items-center gap-1.5 text-sm text-muted hover:text-ink"><ArrowLeft className="h-4 w-4 shrink-0" /> <span className="truncate">{clinic.shortName}</span></Link>
        <div className="flex shrink-0 items-center rounded-full border border-line bg-surface p-0.5">
          {(Object.keys(langLabels) as Lang[]).map((l) => (
            <button key={l} onClick={() => setLang(l)} className={`press rounded-full px-2.5 py-1 text-xs font-medium transition ${lang === l ? "bg-brand text-white" : "text-muted"}`}>{langLabels[l]}</button>
          ))}
        </div>
      </div>

      <h1 className="mt-6 text-3xl font-semibold tracking-tight">{t("myappt.title")}</h1>
      <p className="mt-2 text-[15px] text-muted">{t("myappt.sub")}</p>

      <div className="mt-6 flex gap-2">
        <label htmlFor="myappt-phone" className="sr-only">{t("myappt.phone")}</label>
        <input
          id="myappt-phone"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") search(phone); }}
          placeholder={t("myappt.phone")}
          inputMode="tel"
          className="w-full rounded-xl border border-line bg-bg px-4 py-3 text-[15px] outline-none focus:border-brand focus:bg-surface"
        />
        <button
          onClick={() => search(phone)}
          disabled={loading || !phone.trim()}
          className={`press flex shrink-0 items-center gap-1.5 rounded-xl px-4 py-3 text-sm font-semibold transition ${loading || !phone.trim() ? "cursor-not-allowed bg-line text-muted" : "bg-brand text-white hover:bg-brand-dark"}`}
        >
          <Search className="h-4 w-4" /> <span className="hidden sm:inline">{t("myappt.find")}</span>
        </button>
      </div>

      {loading && <p className="mt-3 text-sm text-muted">{t("myappt.searching")}</p>}
      {err && <p role="alert" className="mt-3 text-sm text-out">{err}</p>}
      {appts && appts.length === 0 && !loading && (
        <p className="mt-3 rounded-xl bg-bg p-4 text-sm text-muted">{t("myappt.none")}</p>
      )}

      {appts && appts.length > 0 && (
        <div className="mt-6 space-y-4">
          {appts.map((a) => (
            <ApptCard key={a.id} appt={a} t={t} onCancelled={onCancelled} onUpdated={updateAppt} />
          ))}
        </div>
      )}
    </main>
  );
}

export function MyAppointment() {
  return (
    <Suspense>
      <MyAppointmentInner />
    </Suspense>
  );
}

function ApptCard({
  appt, t, onCancelled, onUpdated,
}: {
  appt: Appt; t: Tr; onCancelled: (id: string) => void; onUpdated: (a: Appt) => void;
}) {
  const [mode, setMode] = useState<"idle" | "cancelConfirm" | "reschedule">("idle");
  const [busy, setBusy] = useState(false);
  const [payBusy, setPayBusy] = useState(false);
  const [err, setErr] = useState("");
  const d = new Date(appt.date + "T00:00:00");

  const doCancel = async () => {
    setBusy(true); setErr("");
    try {
      if (hasSupabase()) {
        const res = await fetch("/api/appointments/cancel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: appt.id, phone: appt.phone }),
        });
        const data = await res.json();
        if (!res.ok) { setErr(data.error ?? t("myappt.error")); setBusy(false); return; }
      } else {
        cancelBooking(appt.id);
      }
      onCancelled(appt.id);
    } catch {
      setErr(t("myappt.error"));
      setBusy(false);
    }
  };

  const doPay = async () => {
    setPayBusy(true); setErr("");
    try {
      if (hasSupabase()) {
        const res = await fetch("/api/payments/link", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: appt.id, phone: appt.phone }),
        });
        const data = await res.json();
        if (!res.ok) { setErr(data.error ?? t("myappt.payerror")); setPayBusy(false); return; }
        window.location.href = data.url as string;
      } else {
        togglePaid(appt.id);
        onUpdated({ ...appt, paid: true });
        setPayBusy(false);
      }
    } catch {
      setErr(t("myappt.payerror"));
      setPayBusy(false);
    }
  };

  return (
    <div className="rounded-2xl border border-line bg-surface p-5">
      <div className="rounded-2xl bg-brand-tint p-4">
        <div className="text-xs font-semibold uppercase tracking-wider text-brand">{t("book.done.token")}</div>
        <div className="mt-1 text-3xl font-bold text-brand-dark">#{appt.token}</div>
      </div>
      <dl className="mt-4 space-y-2 text-sm">
        <Row icon={User} v={appt.name} />
        <Row icon={CalendarDays} v={d.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" })} />
        <Row icon={Clock} v={fmt(appt.time)} />
        <Row
          icon={Ticket}
          v={`${clinic.doctor.name} · ${clinic.currency}${appt.fee}`}
          badge={
            <span className={`shrink-0 rounded-lg border border-line px-2 py-1 text-[11px] font-medium ${appt.paid ? "text-in" : "text-out"}`}>
              {appt.paid ? t("myappt.paid") : t("myappt.unpaid")}
            </span>
          }
        />
      </dl>

      {err && <p role="alert" className="mt-3 text-sm text-out">{err}</p>}

      {mode === "idle" && (
        <div className="mt-4 flex flex-wrap gap-2">
          {!appt.paid && (
            <button onClick={doPay} disabled={payBusy} className="press flex flex-1 items-center justify-center gap-1.5 rounded-full bg-brand py-2.5 text-sm font-semibold text-white transition disabled:opacity-60">
              <Wallet className="h-4 w-4" /> {t("myappt.paynow")}
            </button>
          )}
          <button onClick={() => setMode("reschedule")} className="press flex flex-1 items-center justify-center gap-1.5 rounded-full border border-line py-2.5 text-sm font-semibold text-ink">
            <PencilLine className="h-4 w-4" /> {t("myappt.reschedule")}
          </button>
          <button onClick={() => setMode("cancelConfirm")} className="press flex flex-1 items-center justify-center gap-1.5 rounded-full border border-line py-2.5 text-sm font-semibold text-out">
            <XCircle className="h-4 w-4" /> {t("myappt.cancel")}
          </button>
        </div>
      )}

      {mode === "cancelConfirm" && (
        <div className="mt-4 rounded-xl bg-bg p-4">
          <p className="text-sm font-medium text-ink">{t("myappt.cancelConfirm")}</p>
          <div className="mt-3 flex gap-2">
            <button onClick={doCancel} disabled={busy} className="press flex-1 rounded-full bg-out py-2.5 text-sm font-semibold text-white transition disabled:opacity-60">
              {busy ? t("myappt.cancelling") : t("myappt.cancelYes")}
            </button>
            <button onClick={() => setMode("idle")} disabled={busy} className="press flex-1 rounded-full border border-line py-2.5 text-sm font-semibold text-ink">
              {t("myappt.cancelNo")}
            </button>
          </div>
        </div>
      )}

      {mode === "reschedule" && (
        <RescheduleFlow
          appt={appt}
          t={t}
          onDone={(updated) => { onUpdated(updated); setMode("idle"); }}
          onCancel={() => setMode("idle")}
        />
      )}
    </div>
  );
}

function RescheduleFlow({
  appt, t, onDone, onCancel,
}: {
  appt: Appt; t: Tr; onDone: (a: Appt) => void; onCancel: () => void;
}) {
  const [days, setDays] = useState<DayOpt[]>([]);
  const [selDate, setSelDate] = useState<string | null>(null);
  const [selTime, setSelTime] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const keys = Array.from({ length: 14 }, (_, i) => {
      const d = new Date(now); d.setDate(now.getDate() + i);
      return { i, d, key: ymd(d) };
    });

    const load = async () => {
      let list: DayOpt[];
      if (hasSupabase()) {
        list = await Promise.all(
          keys.map(async ({ i, d, key }) => {
            let slots: string[] = [];
            let taken: string[] = [];
            try {
              const res = await fetch(`/api/slots?date=${key}`);
              const data = await res.json();
              slots = res.ok ? (data.slots as string[]) : [];
              taken = res.ok ? (data.taken as string[]) : [];
            } catch { slots = []; taken = []; }
            taken = taken.filter((s) => s !== appt.time || key !== appt.date);
            let closingSoon = false;
            if (i === 0) {
              const rawLen = slots.length;
              slots = slots.filter((s) => toMin(s) > nowMin + BOOKING_LEAD_MIN);
              taken = taken.filter((s) => toMin(s) > nowMin + BOOKING_LEAD_MIN);
              closingSoon = rawLen > 0 && slots.length === 0;
            }
            return { date: key, d, slots, taken, closingSoon };
          })
        );
      } else {
        hydrateSchedule();
        list = keys.map(({ i, d, key }) => {
          const takenAll = takenSlots(key).filter((time) => !(key === appt.date && time === appt.time));
          let slots = allSlotsFor(d).filter((time) => !takenAll.includes(time));
          let taken = allSlotsFor(d).filter((time) => takenAll.includes(time));
          let closingSoon = false;
          if (i === 0) {
            const rawLen = slots.length;
            slots = slots.filter((s) => toMin(s) > nowMin + BOOKING_LEAD_MIN);
            taken = taken.filter((s) => toMin(s) > nowMin + BOOKING_LEAD_MIN);
            closingSoon = rawLen > 0 && slots.length === 0;
          }
          return { date: key, d, slots, taken, closingSoon };
        });
      }
      if (cancelled) return;
      setDays(list);
      setSelDate(list.find((x) => x.slots.length > 0)?.date ?? null);
    };
    load();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selDay = useMemo(() => days.find((x) => x.date === selDate), [days, selDate]);
  const timeSlots = useMemo(() => {
    const open = (selDay?.slots ?? []).map((time) => ({ time, taken: false }));
    const gone = (selDay?.taken ?? []).map((time) => ({ time, taken: true }));
    return [...open, ...gone].sort((a, b) => toMin(a.time) - toMin(b.time));
  }, [selDay]);

  const dayLabel = (o: DayOpt, i: number) =>
    i === 0 ? t("book.today") : i === 1 ? t("book.tomorrow") : weekdayName(o.d).slice(0, 3);

  const confirm = async () => {
    if (!selDate || !selTime || busy) return;
    setBusy(true); setErr("");
    try {
      if (hasSupabase()) {
        const res = await fetch("/api/appointments/reschedule", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: appt.id, phone: appt.phone, date: selDate, time: selTime }),
        });
        const data = await res.json();
        if (!res.ok) { setErr(data.error ?? t("myappt.error")); setBusy(false); return; }
        onDone(data.appointment as Appt);
      } else {
        rescheduleBooking(appt.id, selDate, selTime);
        onDone({ ...appt, date: selDate, time: selTime });
      }
    } catch {
      setErr(t("myappt.error"));
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 rounded-xl bg-bg p-4">
      <div className="flex gap-2 overflow-x-auto pb-1" role="group" aria-label={t("book.day")}>
        {days.map((o, i) => {
          const disabled = o.slots.length === 0;
          const active = o.date === selDate;
          return (
            <button
              key={o.date}
              disabled={disabled}
              aria-pressed={active}
              onClick={() => { setSelDate(o.date); setSelTime(null); }}
              className={`press flex min-w-[56px] shrink-0 flex-col items-center rounded-xl border px-2.5 py-2 text-center transition ${active ? "border-brand bg-brand text-white" : disabled ? "border-line bg-surface text-muted/40" : "border-line bg-surface hover:border-brand/40"}`}
            >
              <span className="text-[10px] font-medium uppercase">{dayLabel(o, i)}</span>
              <span className="text-base font-bold leading-tight">{o.d.getDate()}</span>
            </button>
          );
        })}
      </div>

      <div className="mt-3">
        {timeSlots.length === 0 ? (
          <p className="rounded-lg bg-surface p-3 text-sm text-muted">{selDay?.closingSoon ? t("book.closingsoon") : t("book.noslots")}</p>
        ) : (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4" role="group" aria-label={t("book.time")}>
            {timeSlots.map(({ time, taken }) => (
              <button
                key={time}
                disabled={taken}
                aria-pressed={selTime === time}
                aria-disabled={taken}
                onClick={() => !taken && setSelTime(time)}
                className={`press rounded-lg border py-2 text-sm font-medium transition ${
                  taken
                    ? "cursor-not-allowed border-line bg-surface text-muted/50 line-through"
                    : selTime === time
                    ? "border-brand bg-brand text-white"
                    : "border-line bg-surface hover:border-brand/40"
                }`}
              >
                {fmt(time)}
              </button>
            ))}
          </div>
        )}
      </div>

      {err && <p role="alert" className="mt-3 text-sm text-out">{err}</p>}

      <div className="mt-3 flex gap-2">
        <button
          onClick={confirm}
          disabled={!selDate || !selTime || busy}
          className={`press flex-1 rounded-full py-2.5 text-sm font-semibold transition ${!selDate || !selTime || busy ? "cursor-not-allowed bg-line text-muted" : "bg-brand text-white hover:bg-brand-dark"}`}
        >
          {busy ? t("myappt.rescheduling") : t("myappt.rescheduleConfirm")}
        </button>
        <button onClick={onCancel} disabled={busy} className="press flex-1 rounded-full border border-line bg-surface py-2.5 text-sm font-semibold text-ink">
          {t("myappt.cancelNo")}
        </button>
      </div>
    </div>
  );
}

function Row({ icon: Icon, v, badge }: { icon: typeof User; v: string; badge?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 rounded-xl bg-bg px-3 py-2.5">
      <Icon className="h-4 w-4 shrink-0 text-brand" />
      <span className="flex-1 text-ink">{v}</span>
      {badge}
    </div>
  );
}
