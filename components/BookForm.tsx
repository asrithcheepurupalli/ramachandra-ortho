"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft, MessageCircle, CalendarDays, Clock, User,
  ChevronRight, PartyPopper, Ticket,
} from "lucide-react";
import { clinic, type Lang } from "@/clinic.config";
import { tr, langLabels } from "@/lib/i18n";
import { allSlotsFor, ymd, fmt, weekdayName, BOOKING_LEAD_MIN } from "@/lib/schedule";
import { addBooking, takenSlots, hydrateSchedule, type Appt } from "@/lib/store";
import { hasSupabase } from "@/lib/supabase";

const toMin = (t: string) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
const waLink = (msg: string) => `https://wa.me/${clinic.contact.whatsapp.replace(/\D/g, "")}?text=${encodeURIComponent(msg)}`;

// slots = still bookable, taken = already booked (rendered greyed out, not hidden)
type DayOpt = { date: string; d: Date; slots: string[]; taken: string[]; closingSoon?: boolean };

export function BookForm() {
  const [lang, setLang] = useState<Lang>("en");
  const t = (k: string, v?: Record<string, string | number>) => tr(lang, k, v);

  const [days, setDays] = useState<DayOpt[]>([]);
  const [selDate, setSelDate] = useState<string | null>(null);
  const [selTime, setSelTime] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", phone: "", reason: "" });
  const [booked, setBooked] = useState<Appt | null>(null);
  const [err, setErr] = useState("");
  const [submitting, setSubmitting] = useState(false);

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
          const takenAll = takenSlots(key);
          let slots = allSlotsFor(d).filter((t) => !takenAll.includes(t));
          let taken = allSlotsFor(d).filter((t) => takenAll.includes(t));
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
  }, []);

  const selDay = useMemo(() => days.find((x) => x.date === selDate), [days, selDate]);
  // Open and taken slots merged into one time-ordered grid, so a booked slot
  // shows greyed out in place rather than just vanishing from the list.
  const timeSlots = useMemo(() => {
    const open = (selDay?.slots ?? []).map((time) => ({ time, taken: false }));
    const gone = (selDay?.taken ?? []).map((time) => ({ time, taken: true }));
    return [...open, ...gone].sort((a, b) => toMin(a.time) - toMin(b.time));
  }, [selDay]);
  const canBook = !!(selDate && selTime && form.name.trim()) && !submitting;

  const dayLabel = (o: DayOpt, i: number) =>
    i === 0 ? t("book.today") : i === 1 ? t("book.tomorrow") : weekdayName(o.d).slice(0, 3);

  const confirm = async () => {
    if (!form.name.trim()) { setErr(t("book.needname")); return; }
    if (!selDate || !selTime || submitting) return;

    if (hasSupabase()) {
      setSubmitting(true);
      try {
        const res = await fetch("/api/book", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...form, date: selDate, time: selTime, source: "website" }),
        });
        const data = await res.json();
        if (!res.ok) { setErr(data.error ?? "Could not book. Please try again."); return; }
        setBooked(data.appointment as Appt);
      } catch {
        setErr("Could not book. Please try again.");
        return;
      } finally {
        setSubmitting(false);
      }
    } else {
      setBooked(addBooking({ ...form, date: selDate, time: selTime, source: "website" }));
    }
    if (typeof window !== "undefined") window.scrollTo(0, 0);
  };

  /* ── confirmation ─────────────────────────────────────────────────────── */
  if (booked) {
    const d = new Date(booked.date + "T00:00:00");
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-5 py-12">
        <div className="rounded-3xl border border-line bg-surface p-7 text-center shadow-lift">
          <div className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-in/12 text-in"><PartyPopper className="h-8 w-8" /></div>
          <h1 className="mt-5 text-2xl font-semibold">{t("book.done.title")}</h1>
          <div className="mt-5 rounded-2xl bg-brand-tint p-5">
            <div className="text-xs font-semibold uppercase tracking-wider text-brand">{t("book.done.token")}</div>
            <div className="mt-1 text-5xl font-bold text-brand-dark">#{booked.token}</div>
          </div>
          <dl className="mt-5 space-y-2 text-left text-sm">
            <Row icon={User} v={booked.name} />
            <Row icon={CalendarDays} v={d.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" })} />
            <Row icon={Clock} v={fmt(booked.time)} />
            <Row icon={Ticket} v={`${clinic.doctor.name} · ${clinic.currency}${booked.fee}`} />
          </dl>
          <p className="mt-5 text-sm leading-relaxed text-muted">{t("book.done.msg")}</p>
          <p className="mt-2 text-xs leading-relaxed text-brand">{t("book.noshow")}</p>
          <div className="mt-6 flex flex-col gap-2">
            <a href={waLink(`Hi, I have booked appointment token #${booked.token} with Dr. Ramachandra on ${d.toLocaleDateString("en-IN", { day: "numeric", month: "short" })} at ${fmt(booked.time)}.`)} target="_blank" rel="noreferrer" className="press flex items-center justify-center gap-2 rounded-full bg-brand py-3 text-sm font-semibold text-white transition hover:bg-brand-dark"><MessageCircle className="h-4 w-4" /> {t("cta.whatsapp")}</a>
            <div className="flex gap-2">
              <button onClick={() => { setBooked(null); setSelTime(null); setForm({ name: "", phone: "", reason: "" }); }} className="press flex-1 rounded-full border border-line py-3 text-sm font-semibold text-ink">{t("book.done.another")}</button>
              <Link href="/" className="press flex-1 rounded-full border border-line py-3 text-center text-sm font-semibold text-ink">{t("book.done.home")}</Link>
            </div>
          </div>
        </div>
      </main>
    );
  }

  /* ── booking flow ─────────────────────────────────────────────────────── */
  return (
    <main className="mx-auto w-full max-w-lg px-5 pb-28 pt-6 md:pb-12">
      <div className="flex items-center justify-between gap-3">
        <Link href="/" className="press inline-flex min-w-0 items-center gap-1.5 text-sm text-muted hover:text-ink"><ArrowLeft className="h-4 w-4 shrink-0" /> <span className="truncate">{clinic.shortName}</span></Link>
        <div className="flex shrink-0 items-center rounded-full border border-line bg-surface p-0.5">
          {(Object.keys(langLabels) as Lang[]).map((l) => (
            <button key={l} onClick={() => setLang(l)} className={`press rounded-full px-2.5 py-1 text-xs font-medium transition ${lang === l ? "bg-brand text-white" : "text-muted"}`}>{langLabels[l]}</button>
          ))}
        </div>
      </div>

      <h1 className="mt-6 text-3xl font-semibold tracking-tight">{t("book.title")}</h1>
      <p className="mt-2 text-[15px] text-muted">{t("book.sub")}</p>

      <div className="mt-7 space-y-7 rounded-3xl border border-line bg-surface p-5 md:p-6">
        {/* day */}
        <div>
          <Label icon={CalendarDays} n="1">{t("book.day")}</Label>
          <div className="mt-3 flex gap-2 overflow-x-auto pb-1" role="group" aria-label={t("book.day")}>
            {days.map((o, i) => {
              const disabled = o.slots.length === 0;
              const active = o.date === selDate;
              return (
                <button key={o.date} disabled={disabled} aria-pressed={active} onClick={() => { setSelDate(o.date); setSelTime(null); }}
                  className={`press flex min-w-[64px] shrink-0 flex-col items-center rounded-2xl border px-3 py-2.5 text-center transition ${active ? "border-brand bg-brand text-white" : disabled ? "border-line bg-bg text-muted/40" : "border-line bg-surface hover:border-brand/40"}`}>
                  <span className="text-[11px] font-medium uppercase">{dayLabel(o, i)}</span>
                  <span className="text-lg font-bold leading-tight">{o.d.getDate()}</span>
                  <span className={`text-[10px] ${active ? "text-white/80" : "text-muted"}`}>{disabled ? t("book.closed") : `${o.slots.length}`}</span>
                </button>
              );
            })}
          </div>
          <p className="mt-2 text-xs text-muted">{t("book.noshow")}</p>
        </div>

        {/* time */}
        <div>
          <Label icon={Clock} n="2">{t("book.time")}</Label>
          {timeSlots.length === 0 ? (
            <p className="mt-3 rounded-xl bg-bg p-4 text-sm text-muted">{selDay?.closingSoon ? t("book.closingsoon") : t("book.noslots")}</p>
          ) : (
            <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4" role="group" aria-label={t("book.time")}>
              {timeSlots.map(({ time, taken }) => (
                <button
                  key={time}
                  disabled={taken}
                  aria-pressed={selTime === time}
                  aria-disabled={taken}
                  onClick={() => !taken && setSelTime(time)}
                  className={`press rounded-xl border py-2.5 text-sm font-medium transition ${
                    taken
                      ? "cursor-not-allowed border-line bg-bg text-muted/50 line-through"
                      : selTime === time
                      ? "border-brand bg-brand text-white"
                      : "border-line hover:border-brand/40"
                  }`}
                >
                  {fmt(time)}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* details */}
        <div>
          <Label icon={User} n="3">{t("book.details")}</Label>
          <div className="mt-3 space-y-2">
            <label htmlFor="book-name" className="sr-only">{t("book.name")}</label>
            <input id="book-name" value={form.name} onChange={(e) => { setForm({ ...form, name: e.target.value }); setErr(""); }} placeholder={t("book.name")} aria-describedby={err ? "book-error" : undefined} aria-invalid={!!err} className="w-full rounded-xl border border-line bg-bg px-4 py-3 text-[15px] outline-none focus:border-brand focus:bg-surface" />
            <label htmlFor="book-phone" className="sr-only">{t("book.phone")}</label>
            <input id="book-phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder={t("book.phone")} inputMode="tel" className="w-full rounded-xl border border-line bg-bg px-4 py-3 text-[15px] outline-none focus:border-brand focus:bg-surface" />
            <label htmlFor="book-reason" className="sr-only">{t("book.reason")}</label>
            <input id="book-reason" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder={t("book.reason")} className="w-full rounded-xl border border-line bg-bg px-4 py-3 text-[15px] outline-none focus:border-brand focus:bg-surface" />
          </div>
          {err && <p id="book-error" role="alert" className="mt-2 text-sm text-out">{err}</p>}
        </div>
      </div>

      {/* action — sticky on mobile, inline on desktop */}
      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-bg/90 px-5 py-3 backdrop-blur-md md:static md:mt-6 md:border-0 md:bg-transparent md:p-0" style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}>
        <div className="mx-auto max-w-lg">
          <button onClick={confirm} disabled={!canBook} className={`press flex w-full items-center justify-center gap-2 rounded-full py-3.5 text-[15px] font-semibold transition ${canBook ? "bg-brand text-white hover:bg-brand-dark" : "cursor-not-allowed bg-line text-muted"}`}>
            {canBook ? <>{t("book.confirm")}{selTime && selDate ? ` · ${fmt(selTime)}` : ""} <ChevronRight className="h-4 w-4" /></> : <>{t("book.pickslot")}</>}
          </button>
        </div>
      </div>
    </main>
  );
}

function Label({ icon: Icon, n, children }: { icon: typeof User; n: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="grid h-6 w-6 place-items-center rounded-full bg-brand text-[11px] font-bold text-white">{n}</span>
      <span className="flex items-center gap-1.5 text-sm font-semibold"><Icon className="h-4 w-4 text-brand" /> {children}</span>
    </div>
  );
}

function Row({ icon: Icon, v }: { icon: typeof User; v: string }) {
  return (
    <div className="flex items-center gap-2.5 rounded-xl bg-bg px-3 py-2.5">
      <Icon className="h-4 w-4 shrink-0 text-brand" />
      <span className="text-ink">{v}</span>
    </div>
  );
}
