"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft, MessageCircle, CalendarDays, Clock, User,
  ChevronRight, PartyPopper, Ticket,
} from "lucide-react";
import { clinic, type Lang } from "@/clinic.config";
import { tr, langLabels } from "@/lib/i18n";
import { slotsFor, ymd, fmt, weekdayName } from "@/lib/schedule";
import { addBooking, takenSlots, hydrateSchedule, type Appt } from "@/lib/store";

const toMin = (t: string) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
const waLink = (msg: string) => `https://wa.me/${clinic.contact.whatsapp.replace(/\D/g, "")}?text=${encodeURIComponent(msg)}`;

type DayOpt = { date: string; d: Date; slots: string[] };

export default function BookPage() {
  const [lang, setLang] = useState<Lang>("en");
  const t = (k: string, v?: Record<string, string | number>) => tr(lang, k, v);

  const [days, setDays] = useState<DayOpt[]>([]);
  const [selDate, setSelDate] = useState<string | null>(null);
  const [selTime, setSelTime] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", phone: "", reason: "" });
  const [booked, setBooked] = useState<Appt | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    hydrateSchedule();
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const list: DayOpt[] = [];
    for (let i = 0; i < 14; i++) {
      const d = new Date(now); d.setDate(now.getDate() + i);
      const key = ymd(d);
      let slots = slotsFor(d, takenSlots(key));
      if (i === 0) slots = slots.filter((s) => toMin(s) > nowMin + 10); // small buffer for today
      list.push({ date: key, d, slots });
    }
    setDays(list);
    setSelDate(list.find((x) => x.slots.length > 0)?.date ?? null);
  }, []);

  const slots = useMemo(() => days.find((x) => x.date === selDate)?.slots ?? [], [days, selDate]);
  const canBook = !!(selDate && selTime && form.name.trim());

  const dayLabel = (o: DayOpt, i: number) =>
    i === 0 ? t("book.today") : i === 1 ? t("book.tomorrow") : weekdayName(o.d).slice(0, 3);

  const confirm = () => {
    if (!form.name.trim()) { setErr(t("book.needname")); return; }
    if (!selDate || !selTime) return;
    setBooked(addBooking({ ...form, date: selDate, time: selTime, source: "website" }));
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
          <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
            {days.map((o, i) => {
              const disabled = o.slots.length === 0;
              const active = o.date === selDate;
              return (
                <button key={o.date} disabled={disabled} onClick={() => { setSelDate(o.date); setSelTime(null); }}
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
          {slots.length === 0 ? (
            <p className="mt-3 rounded-xl bg-bg p-4 text-sm text-muted">{t("book.noslots")}</p>
          ) : (
            <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4">
              {slots.map((s) => (
                <button key={s} onClick={() => setSelTime(s)} className={`press rounded-xl border py-2.5 text-sm font-medium transition ${selTime === s ? "border-brand bg-brand text-white" : "border-line hover:border-brand/40"}`}>{fmt(s)}</button>
              ))}
            </div>
          )}
        </div>

        {/* details */}
        <div>
          <Label icon={User} n="3">{t("book.details")}</Label>
          <div className="mt-3 space-y-2">
            <input value={form.name} onChange={(e) => { setForm({ ...form, name: e.target.value }); setErr(""); }} placeholder={t("book.name")} className="w-full rounded-xl border border-line bg-bg px-4 py-3 text-[15px] outline-none focus:border-brand focus:bg-surface" />
            <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder={t("book.phone")} inputMode="tel" className="w-full rounded-xl border border-line bg-bg px-4 py-3 text-[15px] outline-none focus:border-brand focus:bg-surface" />
            <input value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder={t("book.reason")} className="w-full rounded-xl border border-line bg-bg px-4 py-3 text-[15px] outline-none focus:border-brand focus:bg-surface" />
          </div>
          {err && <p className="mt-2 text-sm text-out">{err}</p>}
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
