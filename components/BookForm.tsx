"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft, MessageCircle, CalendarDays, Clock, User,
  ChevronRight, PartyPopper, Ticket, Wallet, BadgeCheck,
} from "lucide-react";
import { clinic, type Lang } from "@/clinic.config";
import { tr, langLabels } from "@/lib/i18n";
import { allSlotsFor, ymd, fmt, weekdayName, BOOKING_LEAD_MIN } from "@/lib/schedule";
import { addBooking, hydrateSchedule, togglePaid, lookupPatientMock, type Appt } from "@/lib/store";
import { hasSupabase } from "@/lib/supabase";
import { normalizePhone } from "@/lib/phone";

const toMin = (t: string) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
const waLink = (msg: string) => `https://wa.me/${clinic.contact.whatsapp.replace(/\D/g, "")}?text=${encodeURIComponent(msg)}`;

// Progress persistence. sessionStorage keeps an in-progress booking (stage,
// picked day/time, entered details) alive across refresh and back-navigation
// within the tab. localStorage holds the last unpaid payment_pending hold so a
// returning patient can jump straight back to paying and confirming it.
const SESSION_KEY = "ortho_book_session";
const RESUME_KEY = "ortho_resume_payment";
const PAY_WINDOW_MS = 15 * 60 * 1000;

type DayOpt = { date: string; d: Date; slots: string[]; closingSoon?: boolean };

export function BookForm() {
  const [lang, setLang] = useState<Lang>("en");
  const t = (k: string, v?: Record<string, string | number>) => tr(lang, k, v);

  const [days, setDays] = useState<DayOpt[]>([]);
  const [daysLoading, setDaysLoading] = useState(true);
  const [selDate, setSelDate] = useState<string | null>(null);
  const [selTime, setSelTime] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", phone: "", age: 0 as number, gender: "" as "" | "M" | "F" });
  const [booked, setBooked] = useState<Appt | null>(null);
  const [err, setErr] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [payBusy, setPayBusy] = useState(false);
  const [payErr, setPayErr] = useState("");
  const [pendingHold, setPendingHold] = useState(false);

  // New-vs-returning gate: the flow starts on a "new or returning?" step, then
  // moves to the slot picker. Returning patients look up their record by ID or
  // phone so the name locks and the fee reflects the returning rate.
  const [stage, setStage] = useState<"patient" | "book" | "done">("patient");
  const [people, setPeople] = useState<"new" | "returning" | null>(null);
  const [lookupQ, setLookupQ] = useState("");
  const [lookupBusy, setLookupBusy] = useState(false);
  const [lookupErr, setLookupErr] = useState("");
  const [matched, setMatched] = useState<{ name: string; phone: string; patientCode: string; fee: number } | null>(null);
  // Self-declared payment exemption: no old-patient record exists to check
  // either claim against, so both are trusted at booking time and verified in
  // person at the counter (see AGENTS context). Skips payment_pending/Razorpay
  // entirely — the booking lands straight in "reserved".
  const [claim, setClaim] = useState<"returning_unverified" | "review_free" | null>(null);

  // Last unpaid hold, shown as the resume-payment banner on a returning visit.
  const [resume, setResume] = useState<Appt | null>(null);
  // Marks that we restored from sessionStorage, so the day-load effect below
  // leaves a restored selDate alone instead of defaulting it to the first open day.
  const didRestoreRef = useRef(false);

  // Restore an in-progress booking from the tab's session storage.
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(SESSION_KEY);
      if (!saved) return;
      const s = JSON.parse(saved);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrating state from sessionStorage on mount
      if (s.lang) setLang(s.lang);
      if (s.stage === "patient" || s.stage === "book") setStage(s.stage);
      if (s.people === "new" || s.people === "returning") setPeople(s.people);
      if (s.claim === "returning_unverified" || s.claim === "review_free") setClaim(s.claim);
      if (s.matched && typeof s.matched === "object") setMatched(s.matched);
      if (typeof s.lookupQ === "string") setLookupQ(s.lookupQ);
      if (s.form && typeof s.form === "object") setForm(s.form);
      if (typeof s.selDate === "string") { setSelDate(s.selDate); didRestoreRef.current = true; }
      if (typeof s.selTime === "string") setSelTime(s.selTime);
    } catch { /* corrupt session — start fresh */ }
  }, []);

  // A previous visit's abandoned payment_pending hold (or none if it expired
  // while away — the 15-min window has passed, so the row is cancelled anyway).
  useEffect(() => {
    try {
      const raw = localStorage.getItem(RESUME_KEY);
      if (!raw) return;
      const r = JSON.parse(raw) as Partial<Appt> & { id?: string; date?: string; time?: string };
      if (!r.id || !r.date || !r.time) { localStorage.removeItem(RESUME_KEY); return; }
      if (Date.now() - (r.createdAt ?? 0) > PAY_WINDOW_MS) { localStorage.removeItem(RESUME_KEY); return; }
      // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrating resume from localStorage on mount
      setResume(r as Appt);
    } catch { localStorage.removeItem(RESUME_KEY); }
  }, []);

  // Save in-progress progress on every change — but never once a booking lands
  // on the confirmation screen. That state is owned by the localStorage resume
  // entry instead, so a finished flow can't resurrect as a half-filled form.
  useEffect(() => {
    if (booked) return;
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify({ lang, stage, people, claim, matched, lookupQ, form, selDate, selTime }));
    } catch { /* storage full / private mode — resume degrades to nothing */ }
  }, [lang, stage, people, claim, matched, lookupQ, form, selDate, selTime, booked]);

  // A booking landing on the confirmation screen unpaid is a resume candidate:
  // remember it so a patient who abandons the tab can come back and pay. A
  // paid, claimed (counter-pay/free, no online payment ever applies), or
  // absent booking drops it (clearResume handles the paid paths).
  useEffect(() => {
    if (booked && stage === "done" && !booked.paid && !booked.claimType) {
      try { localStorage.setItem(RESUME_KEY, JSON.stringify(booked)); } catch {}
    }
  }, [booked, stage]);

  const clearResume = () => { try { localStorage.removeItem(RESUME_KEY); } catch {} };
  const resumePay = () => {
    if (!resume) return;
    setBooked(resume);
    setStage("done");
    if (typeof window !== "undefined") window.scrollTo(0, 0);
  };

  // Returning patient found: prefill the details and lock the name (the record
  // is the source of truth). Phone is left editable in case a patient now uses
  // a different number, but the fee is still decided server-side from the phone
  // that's actually on the booking.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- prefill from matched patient record
    if (matched) setForm((f) => ({ ...f, name: matched.name, phone: matched.phone }));
  }, [matched]);

  const lookup = async () => {
    const q = lookupQ.trim();
    if (!q) { setLookupErr(t("book.patient.placeholder")); return; }
    setLookupBusy(true); setLookupErr("");
    try {
      let res;
      if (hasSupabase()) {
        const r = await fetch("/api/patients/lookup", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: q }),
        });
        const data = await r.json();
        if (!r.ok) { setLookupErr(data.error ?? t("book.patient.err")); return; }
        res = data;
      } else {
        res = { found: !!lookupPatientMock(q), patient: lookupPatientMock(q) ?? undefined };
      }
      if (res.found && res.patient) {
        setMatched(res.patient);
      } else {
        setMatched(null);
        setLookupErr(t("book.patient.nomatch"));
      }
    } catch {
      setLookupErr(t("book.patient.err"));
    } finally {
      setLookupBusy(false);
    }
  };

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
            try {
              const res = await fetch(`/api/slots?date=${key}`);
              const data = await res.json();
              slots = res.ok ? (data.slots as string[]) : [];
            } catch { slots = []; }
            let closingSoon = false;
            if (i === 0) {
              const rawLen = slots.length;
              slots = slots.filter((s) => toMin(s) > nowMin + BOOKING_LEAD_MIN);
              closingSoon = rawLen > 0 && slots.length === 0;
            }
            return { date: key, d, slots, closingSoon };
          })
        );
      } else {
        hydrateSchedule();
        list = keys.map(({ i, d, key }) => {
          let slots = allSlotsFor(d);
          let closingSoon = false;
          if (i === 0) {
            const rawLen = slots.length;
            slots = slots.filter((s) => toMin(s) > nowMin + BOOKING_LEAD_MIN);
            closingSoon = rawLen > 0 && slots.length === 0;
          }
          return { date: key, d, slots, closingSoon };
        });
      }
      if (cancelled) return;
      setDays(list);
      if (!didRestoreRef.current) {
        setSelDate(list.find((x) => x.slots.length > 0)?.date ?? null);
      }
      setDaysLoading(false);
    };
    load();
    return () => { cancelled = true; };
  }, []);

  const selDay = useMemo(() => days.find((x) => x.date === selDate), [days, selDate]);
  const timeSlots = useMemo(() => {
    return [...(selDay?.slots ?? [])].sort((a, b) => toMin(a) - toMin(b));
  }, [selDay]);
  // The continue button needs day + time only; confirm() validates the
  // details on tap and points at any missing field with an inline error.
  const canBook = !!(selDate && selTime) && !submitting;

  const dayLabel = (o: DayOpt, i: number) =>
    i === 0 ? t("book.today") : i === 1 ? t("book.tomorrow") : weekdayName(o.d).slice(0, 3);

  const confirm = async (replacePending = false) => {
    if (!form.name.trim()) { setErr(t("book.needname")); return; }
    if (!form.phone.trim()) { setErr(t("book.needphone")); return; }
    if (normalizePhone(form.phone).length !== 10) { setErr(t("book.badphone")); return; }
    if (form.age <= 0 || form.age > 150) { setErr(t("book.needage")); return; }
    if (form.gender !== "M" && form.gender !== "F") { setErr(t("book.needgender")); return; }
    if (!selDate || !selTime || submitting) return;

    setPendingHold(false);
    if (hasSupabase()) {
      setSubmitting(true);
      try {
        const res = await fetch("/api/book", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...form, date: selDate, time: selTime, source: "website", replacePending, claim: claim ?? undefined }),
        });
        const data = await res.json();
        if (!res.ok) {
          // Pending hold: user already has an unpaid appointment — offer
          // "Pay for existing" or "Start fresh" inline instead of redirecting.
          if (res.status === 409 && data?.code === "pending_hold") {
            setPendingHold(true);
            setSubmitting(false);
            return;
          }
          setErr(data.error ?? "Could not book. Please try again.");
          return;
        }
        setBooked(data.appointment as Appt);
      } catch {
        setErr("Could not book. Please try again.");
        return;
      } finally {
        setSubmitting(false);
      }
    } else {
      try {
        setBooked(addBooking({ ...form, gender: form.gender || null, date: selDate, time: selTime, source: "website", replacePending, claim: claim ?? undefined }));
      } catch {
        setErr("Could not book. Please try again.");
        return;
      }
    }
    setStage("done");
    if (typeof window !== "undefined") window.scrollTo(0, 0);
  };

  /* ── confirmation ─────────────────────────────────────────────────────── */
  if (stage === "done" && booked) {
    const d = new Date(booked.date + "T00:00:00");

    const doPay = async () => {
      setPayBusy(true); setPayErr("");
      try {
        if (hasSupabase()) {
          const res = await fetch("/api/payments/link", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: booked.id, phone: booked.phone }),
          });
          const data = await res.json();
          if (!res.ok) {
            if (res.status === 400 && data?.code === "already_paid") {
              // The webhook beat us to it — the row is already paid. This is
              // really a confirm, not an error: mirror the paid state and drop
              // the resume entry so we never ask for money again. (A 400 with a
              // different code is a validation error, so only this branch
              // confirms the booking.)
              clearResume();
              setBooked({ ...booked, paid: true, status: "reserved" });
            } else if (res.status === 404) {
              // Hold expired (the payment-timeout cron cancelled it) — nothing
              // left to pay.
              clearResume();
              setPayErr(data.error ?? t("myappt.payerror"));
            } else {
              setPayErr(data.error ?? "Could not get payment link. Tap Pay now to try again.");
            }
            setPayBusy(false);
            return;
          }
          window.location.href = data.url as string;
        } else {
          togglePaid(booked.id);
          // Mirror what the DB webhook does — the paid hold becomes reserved.
          clearResume();
          setBooked({ ...booked, paid: true, status: "reserved" });
          setPayBusy(false);
        }
      } catch {
        setPayErr(t("myappt.payerror"));
        setPayBusy(false);
      }
    };

    return (
      <main key="done" className="stage-in mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-5 py-12">
        <div className="rounded-3xl border border-line bg-surface p-7 text-center shadow-lift">
          <div className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-in/12 text-in"><PartyPopper className="h-8 w-8" /></div>
          <h1 className="mt-5 text-2xl font-semibold">{t("book.done.title")}</h1>
          <div className="mt-5 rounded-2xl bg-brand-tint p-5">
            <div className="text-xs font-semibold uppercase tracking-wider text-brand">{t("book.done.token")}</div>
            <div className="token-pop mt-1 text-5xl font-bold text-brand-dark">#{booked.token}</div>
          </div>
          <dl className="mt-5 space-y-2 text-left text-sm">
            <Row icon={User} v={booked.name} />
            <Row icon={CalendarDays} v={d.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" })} />
            <Row icon={Clock} v={fmt(booked.time)} />
            <Row icon={Ticket} v={`${clinic.doctor.name} · ${clinic.currency}${booked.fee}`} />
            {booked.patientCode && <Row icon={BadgeCheck} v={`${t("book.patient.code")}: ${booked.patientCode}`} />}
          </dl>
          {booked.patientCode && <p className="mt-3 rounded-xl bg-brand-tint px-3 py-2 text-xs text-brand">{t("book.patient.saveid", { code: booked.patientCode })}</p>}
          {booked.claimType === "returning_unverified" ? (
            <div className="mt-4 rounded-2xl border border-accent/40 bg-accent-tint px-4 py-3">
              <p className="text-sm font-semibold text-out">{t("book.done.counterPay", { cur: clinic.currency, fee: booked.fee })}</p>
              <p className="mt-1 text-xs leading-relaxed text-muted">{t("book.done.counterPaySub")}</p>
            </div>
          ) : !booked.paid ? (
            <div className="mt-4 rounded-2xl border border-accent/40 bg-accent-tint px-4 py-3">
              <p className="text-sm font-semibold text-out">{t("book.done.payRequired")}</p>
              <p className="mt-1 text-xs leading-relaxed text-muted">
                {t("book.done.deadline", { time: new Date((booked.paymentDeadlineAt ?? booked.createdAt + 15 * 60_000)).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" }) })}
              </p>
            </div>
          ) : (
            <p className="mt-5 text-sm leading-relaxed text-muted">{t("book.done.msg")}</p>
          )}
          {/* The carry-over-to-next-day line is about confirmed no-shows; an
              unpaid booking is cancelled outright instead, so it would read as
              a contradiction here. Show it once payment confirmed the slot —
              or for a claim booking, which is already "reserved" and carries
              over the same as any other confirmed appointment. */}
          {(booked.paid || booked.claimType) && <p className="mt-2 text-xs leading-relaxed text-brand">{t("book.noshow")}</p>}
          {payErr && <p role="alert" className="mt-3 text-sm text-out">{payErr}</p>}
          <div className="mt-6 flex flex-col gap-2">
            {!booked.paid && !booked.claimType && (
              <button onClick={doPay} disabled={payBusy} className="press flex w-full items-center justify-center gap-2 rounded-full bg-brand px-3 py-3 text-center text-sm font-semibold text-white transition hover:bg-brand-dark disabled:opacity-60">
                {payBusy ? <span className="spinner" aria-hidden /> : <Wallet className="h-4 w-4 shrink-0" />} {t("book.done.paynow")}
              </button>
            )}
            <a href={waLink(`Hi, I have booked appointment token #${booked.token} with Dr. Ramachandra on ${d.toLocaleDateString("en-IN", { day: "numeric", month: "short" })} at ${fmt(booked.time)}.`)} target="_blank" rel="noreferrer" className="press flex w-full items-center justify-center gap-2 rounded-full border border-brand px-3 py-3 text-center text-sm font-semibold text-brand transition hover:bg-brand-tint"><MessageCircle className="h-4 w-4 shrink-0" /> {t("cta.whatsapp")}</a>
            {/* My Appointment won't show a payment_pending row (it's not real
                until paid), so the "View appointment" link would dead-end on
                the empty state. Offer it once payment confirmed the slot — or
                for a claim booking, which is already "reserved" and real. */}
            {(booked.paid || booked.claimType) && <Link href={`/my-appointment?phone=${encodeURIComponent(booked.phone)}`} className="press flex w-full items-center justify-center gap-2 rounded-full border border-line px-3 py-3 text-center text-sm font-semibold text-ink">{t("book.done.view")}</Link>}
            {/* Stacked full-width, not a flex-1 side-by-side row. Telugu/Hindi
                labels ("మరొకటి బుక్ చేయండి") run longer than a half-width
                column can hold on one line. */}
            <div className="grid grid-cols-1 gap-2">
              <button onClick={() => { setBooked(null); clearResume(); setStage("patient"); setPeople(null); setClaim(null); setMatched(null); setSelDate(null); setSelTime(null); setForm({ name: "", phone: "", age: 0, gender: "" }); }} className="press w-full rounded-full border border-line py-3 text-sm font-semibold text-ink">{t("book.done.another")}</button>
              <Link href="/" className="press w-full rounded-full border border-line py-3 text-center text-sm font-semibold text-ink">{t("book.done.home")}</Link>
            </div>
          </div>
        </div>
      </main>
    );
  }

  /* ── new-or-returning gate ────────────────────────────────────────────── */
  if (stage === "patient") {
    return (
      <main key="patient" className="stage-in mx-auto w-full max-w-lg px-5 pb-28 pt-6 md:pb-12">
        <div className="flex items-center justify-between gap-3">
          <Link href="/" className="press inline-flex min-w-0 items-center gap-1.5 text-sm text-muted hover:text-ink"><ArrowLeft className="h-4 w-4 shrink-0" /> <span className="truncate">{clinic.shortName}</span></Link>
          <div className="flex shrink-0 items-center rounded-full border border-line bg-surface p-0.5">
            {(Object.keys(langLabels) as Lang[]).map((l) => (
              <button key={l} onClick={() => setLang(l)} className={`press rounded-full px-2.5 py-1 text-xs font-medium transition ${lang === l ? "bg-brand text-white" : "text-muted"}`}>{langLabels[l]}</button>
            ))}
          </div>
        </div>

        <h1 className="mt-6 text-3xl font-semibold tracking-tight">{t("book.title")}</h1>
        <p className="mt-2 text-[15px] text-muted">{t("book.patient.sub")}</p>

        {resume && (
          <button onClick={resumePay} className="press mt-5 w-full rounded-3xl border border-accent/40 bg-accent-tint p-5 text-left transition hover:border-accent/60">
            <div className="flex items-center gap-3">
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-accent/15 text-out"><Wallet className="h-5 w-5" /></span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-out">{t("book.resume.title")}</div>
                <div className="mt-0.5 text-xs leading-relaxed text-muted">
                  {t("book.resume.detail", {
                    date: new Date(`${resume.date}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short" }),
                    time: fmt(resume.time),
                  })}
                </div>
              </div>
              <ChevronRight className="h-5 w-5 shrink-0 text-muted" />
            </div>
          </button>
        )}

        {people === "returning" ? (
          <div className="mt-7 rounded-3xl border border-line bg-surface p-5 md:p-6">
            <h2 className="text-lg font-semibold">{t("book.patient.find")}</h2>
            <p className="mt-1 text-sm text-muted">{t("book.patient.findsup")}</p>
            <div className="mt-4 space-y-2">
              <label htmlFor="lookup-q" className="sr-only">{t("book.patient.placeholder")}</label>
              <input id="lookup-q" value={lookupQ} onChange={(e) => { setLookupQ(e.target.value); setLookupErr(""); setMatched(null); }} placeholder={t("book.patient.placeholder")} inputMode="tel" className="w-full rounded-xl border border-line bg-bg px-4 py-3 text-[15px] outline-none focus:border-brand focus:bg-surface" />
              <button onClick={lookup} disabled={lookupBusy} className="press flex w-full items-center justify-center gap-2 rounded-full bg-brand py-3.5 text-[15px] font-semibold text-white transition hover:bg-brand-dark disabled:opacity-60">
                {lookupBusy ? <><span className="spinner" aria-hidden /> {t("book.patient.looking")}</> : <>{t("book.patient.lookup")} <ChevronRight className="h-4 w-4" /></>}
              </button>
            </div>

            {matched ? (
              <div className="mt-4 rounded-2xl bg-brand-tint p-4">
                <div className="text-sm font-semibold text-brand">{t("book.patient.welcome", { name: matched.name })}</div>
                <div className="mt-1 text-xs text-brand/80">{t("book.patient.code")}: <b>{matched.patientCode}</b> · {clinic.currency}{clinic.returningFee}</div>
                <button onClick={() => setStage("book")} className="press mt-4 w-full rounded-full bg-brand py-3 text-sm font-semibold text-white transition hover:bg-brand-dark">{t("cta.bookShort")} <ChevronRight className="ml-1 inline h-4 w-4" /></button>
              </div>
            ) : (
              <p className="mt-3 text-sm text-out" role="alert">{lookupErr}</p>
            )}

            <button onClick={() => { setPeople(null); setMatched(null); setLookupQ(""); setLookupErr(""); }} className="press mt-4 text-sm font-semibold text-brand">{t("book.patient.actuallynew")}</button>

            {/* Self-declared escape hatch: no pre-launch patient data exists to
                match against, so a returning patient who doesn't find their
                record can still book, at the counter-pay rate, verified in
                person — rather than dead-ending on lookupErr. */}
            {lookupErr && (
              <button onClick={() => { setClaim("returning_unverified"); setStage("book"); }} className="press mt-3 w-full rounded-2xl border border-accent/40 bg-accent-tint px-4 py-3 text-left text-sm font-semibold text-out transition hover:border-accent/60">
                {t("book.patient.unverified", { cur: clinic.currency, fee: clinic.returningFee })}
              </button>
            )}
          </div>
        ) : (
          <div className="mt-7 space-y-3">
            <button onClick={() => { setPeople("new"); setStage("book"); }} className="press w-full rounded-3xl border border-line bg-surface p-5 text-left transition hover:border-brand/40">
              <div className="flex items-center gap-3">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-brand-tint text-brand"><User className="h-5 w-5" /></span>
                <div className="min-w-0 flex-1">
                  <div className="font-semibold">{t("book.patient.new")}</div>
                  <div className="text-sm text-muted">{t("book.patient.newsub", { cur: clinic.currency, fee: clinic.consultationFee })}</div>
                </div>
                <ChevronRight className="h-5 w-5 shrink-0 text-muted" />
              </div>
            </button>
            <button onClick={() => setPeople("returning")} className="press w-full rounded-3xl border border-line bg-surface p-5 text-left transition hover:border-brand/40">
              <div className="flex items-center gap-3">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-brand-tint text-brand"><BadgeCheck className="h-5 w-5" /></span>
                <div className="min-w-0 flex-1">
                  <div className="font-semibold">{t("book.patient.returning")}</div>
                  <div className="text-sm text-muted">{t("book.patient.returningsub", { cur: clinic.currency, fee: clinic.returningFee })}</div>
                </div>
                <ChevronRight className="h-5 w-5 shrink-0 text-muted" />
              </div>
            </button>
            <p className="pt-1 text-center text-xs text-muted">{t("book.patient.hint", { cur: clinic.currency, fee: clinic.returningFee, reg: clinic.consultationFee })}</p>
            <button onClick={() => { setClaim("review_free"); setStage("book"); }} className="press w-full text-center text-sm font-semibold text-brand">{t("book.patient.reviewlink")}</button>
          </div>
        )}
      </main>
    );
  }

  /* ── booking flow ─────────────────────────────────────────────────────── */
  return (
    <main key="book" className="stage-in mx-auto w-full max-w-lg px-5 pb-28 pt-6 md:pb-12">
      <div className="flex items-center justify-between gap-3">
        <button onClick={() => { setStage("patient"); setPeople(null); setClaim(null); setMatched(null); setSelDate(null); setSelTime(null); }} className="press inline-flex min-w-0 items-center gap-1.5 text-sm text-muted hover:text-ink"><ArrowLeft className="h-4 w-4 shrink-0" /> <span className="truncate">{t("book.patient.back")}</span></button>
        <div className="flex shrink-0 items-center rounded-full border border-line bg-surface p-0.5">
          {(Object.keys(langLabels) as Lang[]).map((l) => (
            <button key={l} onClick={() => setLang(l)} className={`press rounded-full px-2.5 py-1 text-xs font-medium transition ${lang === l ? "bg-brand text-white" : "text-muted"}`}>{langLabels[l]}</button>
          ))}
        </div>
      </div>

      {people === "returning" && matched && (
        <div className="mt-5 rounded-2xl bg-brand-tint px-4 py-3 text-sm text-brand">{t("book.patient.welcome", { name: matched.name })} · {t("book.patient.code")}: <b>{matched.patientCode}</b></div>
      )}

      <h1 className="mt-6 text-3xl font-semibold tracking-tight">{t("book.title")}</h1>
      <p className="mt-2 text-[15px] text-muted">{t("book.sub")}</p>

      <div className="mt-7 space-y-7 rounded-3xl border border-line bg-surface p-5 md:p-6">
        {/* day */}
        <div>
          <Label icon={CalendarDays} n="1">{t("book.day")}</Label>
          <div className="mt-3 flex gap-2 overflow-x-auto pb-1" role="group" aria-label={t("book.day")}>
            {daysLoading
              ? Array.from({ length: 7 }, (_, i) => (
                  <div key={i} className="flex min-w-[64px] shrink-0 animate-pulse flex-col items-center gap-1.5 rounded-2xl border border-line bg-bg px-3 py-2.5">
                    <span className="h-2.5 w-8 rounded bg-line" />
                    <span className="h-5 w-5 rounded bg-line" />
                    <span className="h-2 w-4 rounded bg-line" />
                  </div>
                ))
              : days.map((o, i) => {
                  const disabled = o.slots.length === 0;
                  const active = o.date === selDate;
                  return (
                    <button key={o.date} disabled={disabled} aria-pressed={active} onClick={() => { setSelDate(o.date); setSelTime(null); }}
                      className={`press flex min-w-[64px] shrink-0 flex-col items-center rounded-2xl border px-3 py-2.5 text-center transition ${active ? "pop border-brand bg-brand text-white" : disabled ? "border-line bg-bg text-muted/40" : "border-line bg-surface hover:border-brand/40"}`}>
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
              {timeSlots.map((time) => (
                <button
                  key={time}
                  aria-pressed={selTime === time}
                  onClick={() => setSelTime(time)}
                  className={`press rounded-xl border py-2.5 text-sm font-medium transition ${
                    selTime === time
                      ? "pop border-brand bg-brand text-white"
                      : "border-line hover:border-brand/40"
                  }`}
                >
                  {fmt(time)}
                </button>
              ))}
            </div>
          )}
          <p className="mt-2 text-xs text-muted">{t("book.waitnote")}</p>
        </div>

        {/* details */}
        <div>
          <Label icon={User} n="3">{t("book.details")}</Label>
          <div className="mt-3 space-y-2">
            <label htmlFor="book-name" className="sr-only">{t("book.name")}</label>
            <input id="book-name" value={form.name} onChange={(e) => { setForm({ ...form, name: e.target.value }); setErr(""); }} placeholder={t("book.name")} readOnly={people === "returning" && !!matched} aria-describedby={err ? "book-error" : undefined} aria-invalid={!!err} className="w-full rounded-xl border border-line bg-bg px-4 py-3 text-[15px] outline-none focus:border-brand focus:bg-surface read-only:opacity-70" />
            <label htmlFor="book-phone" className="sr-only">{t("book.phone")}</label>
            <input id="book-phone" value={form.phone} onChange={(e) => { setForm({ ...form, phone: e.target.value }); setErr(""); }} placeholder={t("book.phone")} inputMode="tel" className="w-full rounded-xl border border-line bg-bg px-4 py-3 text-[15px] outline-none focus:border-brand focus:bg-surface" />
            <label htmlFor="book-age" className="sr-only">{t("book.age")}</label>
            <input id="book-age" type="number" value={form.age || ""} onChange={(e) => setForm({ ...form, age: e.target.value ? Number(e.target.value) : 0 })} placeholder={t("book.age")} min="1" max="150" required className="w-full rounded-xl border border-line bg-bg px-4 py-3 text-[15px] outline-none focus:border-brand focus:bg-surface" />
            <fieldset className="grid w-full grid-cols-2 gap-2">
              <legend className="sr-only">{t("book.gender")}</legend>
              {(["M", "F"] as const).map((g) => (
                <button
                  key={g}
                  type="button"
                  aria-pressed={form.gender === g}
                  onClick={() => setForm({ ...form, gender: g })}
                  className={`press rounded-xl border py-3 text-[15px] font-medium transition ${
                    form.gender === g ? "pop border-brand bg-brand text-white" : "border-line bg-bg text-ink hover:border-brand/40"
                  }`}
                >
                  {g === "M" ? t("book.male") : t("book.female")}
                </button>
              ))}
            </fieldset>
          </div>
          {err && <p id="book-error" role="alert" className="mt-2 text-sm text-out">{err}</p>}
          {pendingHold && (
            <div className="mt-3 rounded-xl border border-accent/40 bg-accent-tint p-4">
              <p className="text-sm font-semibold text-out">{t("book.pendingHold.title")}</p>
              <p className="mt-1 text-xs leading-relaxed text-muted">{t("book.pendingHold.detail")}</p>
              <div className="mt-3 flex flex-col gap-2">
                <a href={`/my-appointment?phone=${encodeURIComponent(form.phone.trim())}`} className="press flex w-full items-center justify-center gap-2 rounded-full bg-brand px-3 py-3 text-center text-sm font-semibold text-white transition hover:bg-brand-dark">
                  <Wallet className="h-4 w-4 shrink-0" /> {t("book.pendingHold.pay")}
                </a>
                <button onClick={() => confirm(true)} disabled={submitting} className="press flex w-full items-center justify-center gap-2 rounded-full border border-line px-3 py-3 text-sm font-semibold text-ink transition hover:bg-line/40 disabled:opacity-60">
                  {t("book.pendingHold.startOver")}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* action — sticky on mobile, inline on desktop */}
      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-bg/90 px-5 py-3 backdrop-blur-md md:static md:mt-6 md:border-0 md:bg-transparent md:p-0" style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}>
        <div className="mx-auto max-w-lg">
          <button onClick={() => confirm()} disabled={!canBook} className={`press flex w-full items-center justify-center gap-2 rounded-full py-3.5 text-[15px] font-semibold transition ${selDate && selTime ? "bg-brand text-white hover:bg-brand-dark" : "cursor-not-allowed bg-line text-muted"}`}>
            {submitting ? (
              <><span className="spinner" aria-hidden /> {t("book.confirm")}</>
            ) : canBook ? (
              <>{t("book.confirm")}{selTime && selDate ? ` · ${fmt(selTime)}` : ""} <ChevronRight className="h-4 w-4" /></>
            ) : (
              <>{t("book.pickslot")}</>
            )}
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
