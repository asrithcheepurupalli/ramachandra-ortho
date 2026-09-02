"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import {
  Activity, Ambulance, Bone, Dumbbell, HandHeart,
  PersonStanding, Spline, Volleyball, Scan,
  Star, MapPin, MessageCircle, CalendarPlus, Phone, ChevronRight,
  ArrowRight, Navigation, Quote, ShieldCheck, Zap, Ticket, Check, TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { clinic, type Lang } from "@/clinic.config";
import { tr, langLabels } from "@/lib/i18n";
import { serviceGroups } from "@/lib/services";
import { reviews } from "@/lib/reviews";
import { WhatsAppDemo } from "@/components/WhatsAppDemo";
import { DoctorPhoto } from "@/components/DoctorPhoto";
import { RCChat } from "@/components/RCChat";
import {
  weeklyHours, statusAt, fmt, weekdayName, applySchedule, setOverride,
  type Status, type WeeklyHours, type Exception, type Override,
} from "@/lib/schedule";
import { hydrateSchedule } from "@/lib/store";
import { hasSupabase, supabaseBrowser } from "@/lib/supabase";

const iconMap: Record<string, LucideIcon> = {
  Bone, PersonStanding, Activity, Spline, Volleyball, Ambulance, Dumbbell,
  HandHeart, Scan,
};
const waLink = (msg: string) =>
  `https://wa.me/${clinic.contact.whatsapp.replace(/\D/g, "")}?text=${encodeURIComponent(msg)}`;
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const dayIdx = (name: string) => (name === "Sunday" ? 0 : DAYS.indexOf(name) + 1);

type T = (k: string, v?: Record<string, string | number>) => string;

export default function Home() {
  const [lang, setLang] = useState<Lang>("en");
  const [status, setStatus] = useState<Status | null>(null);
  const t: T = (k, v) => tr(lang, k, v);

  useEffect(() => {
    let cancelled = false;
    const recompute = async () => {
      if (hasSupabase()) {
        const { data, error } = await supabaseBrowser()
          .from("settings")
          .select("weekly, exceptions, override")
          .eq("id", 1)
          .single();
        if (!error && data) {
          applySchedule(data.weekly as WeeklyHours, (data.exceptions as Record<string, Exception>) ?? {});
          setOverride((data.override as Override | null) ?? null);
        }
      } else {
        hydrateSchedule();
      }
      if (!cancelled) setStatus(statusAt());
    };
    recompute();
    const id = setInterval(recompute, 60_000);
    const onStorage = (e: StorageEvent) => { if (!hasSupabase() && (!e.key || e.key === "roc.schedule.v1")) recompute(); };
    window.addEventListener("storage", onStorage);
    return () => { cancelled = true; clearInterval(id); window.removeEventListener("storage", onStorage); };
  }, []);

  return (
    <>
      <Nav lang={lang} setLang={setLang} t={t} />
      <Hero status={status} t={t} />
      <HelpBand t={t} />
      <WhatsAppSection />
      <Services t={t} />
      <Reviews t={t} />
      <DoctorStrip t={t} />
      <LocationHours t={t} />
      <Footer t={t} />
      <MobileBar t={t} />
      <RCChat />
    </>
  );
}

/* ── Nav ─────────────────────────────────────────────────────────────────── */
function Nav({ lang, setLang, t }: { lang: Lang; setLang: (l: Lang) => void; t: T }) {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 8);
    on(); window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);
  return (
    <nav className={`sticky top-0 z-50 transition-all duration-300 ${scrolled ? "border-b border-line bg-bg/85 backdrop-blur-md shadow-[0_1px_0_rgba(0,0,0,0.02)]" : "bg-transparent"}`}>
      <div className="mx-auto flex max-w-6xl items-center justify-between px-5 md:px-8 h-16">
        <Link href="/" className="flex items-center gap-2.5 group">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand text-white transition group-hover:rotate-6"><Bone className="h-[18px] w-[18px]" /></span>
          <span className="whitespace-nowrap text-[15px] md:text-base font-semibold leading-none">Ramachandra <span className="text-brand">Ortho<span className="hidden sm:inline"> Care</span></span></span>
        </Link>
        <div className="flex items-center gap-1.5 md:gap-2">
          <div className="hidden md:flex items-center gap-1 mr-1">
            {[["services", "nav.services"], ["reviews", "nav.reviews"], ["location", "nav.location"]].map(([id, k]) => (
              <a key={id} href={`#${id}`} className="ulink rounded-lg px-3 py-2 text-sm text-muted hover:text-ink">{t(k)}</a>
            ))}
          </div>
          <LangToggle lang={lang} setLang={setLang} />
          {/* Book lives in the mobile action bar on phones, so the nav stays clean */}
          <Link href="/book" className="press ml-0.5 hidden md:inline-flex items-center gap-1.5 rounded-full bg-brand px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-dark">
            {t("nav.book")} <ChevronRight className="h-4 w-4" />
          </Link>
        </div>
      </div>
    </nav>
  );
}

function LangToggle({ lang, setLang }: { lang: Lang; setLang: (l: Lang) => void }) {
  return (
    <div className="flex items-center rounded-full border border-line bg-surface/70 p-0.5">
      {(Object.keys(langLabels) as Lang[]).map((l) => (
        <button key={l} onClick={() => setLang(l)} className={`press rounded-full px-2.5 py-1 text-xs font-medium transition ${lang === l ? "bg-brand text-white" : "text-muted hover:text-ink"}`}>
          {langLabels[l]}
        </button>
      ))}
    </div>
  );
}

/* ── Hero ────────────────────────────────────────────────────────────────── */
function Hero({ status, t }: { status: Status | null; t: T }) {
  return (
    <header className="relative overflow-hidden">
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="blob absolute -top-32 -right-24 h-[26rem] w-[26rem] rounded-full bg-brand-tint blur-3xl opacity-70" />
        <div className="blob absolute top-40 -left-32 h-80 w-80 rounded-full bg-accent-tint blur-3xl opacity-60" style={{ animationDelay: "-6s" }} />
      </div>
      <div className="mx-auto grid max-w-6xl grid-cols-1 items-center gap-7 px-5 md:gap-10 md:px-8 pt-4 pb-10 md:pt-16 md:pb-24 lg:grid-cols-12">
        <div className="lg:col-span-7">
          <Reveal>
            <span className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-2.5 py-1 text-[12px] font-medium text-brand shadow-soft md:px-3 md:py-1.5 md:text-[13px]">
              <ShieldCheck className="h-3.5 w-3.5 md:h-4 md:w-4" /> {t("hero.kicker")}
            </span>
          </Reveal>
          <Reveal delay={60}>
            <h1 className="mt-4 text-[1.6rem] font-semibold leading-[1.15] tracking-[-0.02em] md:mt-6 md:text-[3.4rem] md:leading-[1.03] text-ink text-balance">{t("hero.title")}</h1>
          </Reveal>
          <Reveal delay={120}>
            <p className="mt-3 max-w-lg text-[14px] leading-relaxed text-muted md:mt-5 md:text-[17px]">{t("hero.subtitle")}</p>
          </Reveal>
          {/* On phones the Today card + sticky bar carry the actions, so this
              button pair is desktop-only to keep the mobile hero uncluttered. */}
          <Reveal delay={180}>
            <div className="mt-8 hidden flex-wrap items-center gap-3 md:flex">
              <Link href="/book" className="press group inline-flex items-center gap-2 rounded-full bg-brand px-6 py-3.5 text-[15px] font-semibold text-white shadow-soft transition hover:bg-brand-dark">
                <CalendarPlus className="h-[18px] w-[18px]" /> {t("cta.book")}
                <ArrowRight className="h-4 w-4 transition group-hover:translate-x-0.5" />
              </Link>
              <a href={waLink("Hi, I would like to book an appointment with Dr. Ramachandra.")} target="_blank" rel="noreferrer" className="press inline-flex items-center gap-2 rounded-full border border-line bg-surface px-6 py-3.5 text-[15px] font-semibold text-ink transition hover:border-brand/40">
                <MessageCircle className="h-[18px] w-[18px] text-brand" /> {t("cta.whatsapp")}
              </a>
            </div>
          </Reveal>
          <Reveal delay={240}>
            <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-1.5 md:mt-8">
              <div className="flex items-center gap-2">
                <Stars n={5} />
                <span className="font-semibold text-ink">{clinic.rating.score}</span>
                <span className="text-sm text-muted">· {clinic.rating.count} {clinic.rating.source} reviews</span>
              </div>
              <span className="hidden sm:block h-4 w-px bg-line" />
              <span className="text-sm text-muted">{t("hero.trust")}</span>
            </div>
          </Reveal>
        </div>

        {/* Clinic photo + the live Today card floating over it */}
        <div className="lg:col-span-5">
          <Reveal delay={140}>
            <div className="relative">
              <div className="overflow-hidden rounded-3xl border border-line shadow-soft">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="/clinic-reception.jpg"
                  alt={`Reception at ${clinic.name}`}
                  className="h-56 w-full object-cover sm:h-64 md:h-[21rem]"
                />
              </div>
              <div className="relative z-10 mt-4 md:-mt-16 md:px-4">
                <TodayCard status={status} t={t} />
              </div>
            </div>
          </Reveal>
        </div>
      </div>
    </header>
  );
}

function TodayCard({ status, t }: { status: Status | null; t: T }) {
  const inState = status?.state === "in";
  const color = !status ? "var(--color-muted)" : status.state === "in" ? "var(--color-in)" : status.state === "soon" ? "var(--color-accent)" : "var(--color-out)";
  const line1 = !status ? "…" : status.state === "in" ? t("avail.in") : status.state === "soon" ? t("avail.soon", { t: fmt(status.opensAt) }) : t("avail.out");
  const line2 = !status ? "" : status.state === "in" ? t("avail.until", { t: fmt(status.until) }) : status.state === "out" && status.next ? t("avail.next", { day: weekdayName(status.next.date), t: fmt(status.next.opensAt) }) : "";

  return (
    <div className="rounded-3xl border border-line bg-surface p-5 shadow-lift md:p-6">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted md:text-xs">{t("today.card")}</span>
        <span className="flex items-center gap-1.5 text-[11px] font-medium md:text-xs" style={{ color }}>
          <span className="relative flex h-2 w-2"><span className="pulse-dot absolute h-full w-full rounded-full" style={{ color }} /><span className="relative h-2 w-2 rounded-full" style={{ background: color }} /></span>
          {t("avail.label")}
        </span>
      </div>

      <div className="mt-3.5 rounded-2xl p-3.5 md:p-4" style={{ background: inState ? "var(--color-brand-tint)" : "color-mix(in srgb, var(--color-bg) 60%, white)" }}>
        <div className="text-[17px] font-semibold md:text-xl" style={{ color: inState ? "var(--color-brand-dark)" : "var(--color-ink)" }}>{line1}</div>
        {line2 && <div className="mt-0.5 text-[13px] text-muted md:text-sm">{line2}</div>}
      </div>

      <div className="mt-3.5 flex items-center gap-3">
        <DoctorPhoto className="h-10 w-10 shrink-0 rounded-xl text-sm md:h-11 md:w-11" />
        <div className="min-w-0">
          <div className="truncate text-[14px] font-semibold md:text-[15px]">{clinic.doctor.name}</div>
          <div className="truncate text-[11px] text-muted md:text-xs">{clinic.doctor.title}</div>
        </div>
        <span className="ml-auto shrink-0 rounded-full bg-brand-tint px-2.5 py-1 text-xs font-semibold text-brand">{clinic.currency}{clinic.consultationFee}</span>
      </div>

      <div className="mt-3.5 grid grid-cols-2 gap-2">
        <Link href="/book" className="press flex items-center justify-center gap-1.5 whitespace-nowrap rounded-xl bg-brand px-2 py-2.5 text-[13px] font-semibold text-white transition hover:bg-brand-dark md:py-3 md:text-sm"><Ticket className="h-4 w-4 shrink-0" /> {t("cta.bookShort")}</Link>
        <a href={`tel:${clinic.contact.phone}`} className="press flex items-center justify-center gap-1.5 whitespace-nowrap rounded-xl border border-line px-2 py-2.5 text-[13px] font-semibold text-ink transition hover:border-brand/40 md:py-3 md:text-sm"><Phone className="h-4 w-4 shrink-0 text-brand" /> {t("cta.call")}</a>
      </div>
    </div>
  );
}

/* ── Help band — why this clinic's site is worth using ─────────────────────── */
function HelpBand({ t }: { t: T }) {
  const items = [
    { icon: ShieldCheck, t: t("help.know.t"), d: t("help.know.d") },
    { icon: Zap, t: t("help.book.t"), d: t("help.book.d") },
    { icon: Ticket, t: t("help.wait.t"), d: t("help.wait.d") },
  ];
  return (
    <section className="mx-auto max-w-6xl px-5 md:px-8 py-6">
      <Reveal><h2 className="text-center text-sm font-semibold uppercase tracking-wider text-muted">{t("help.title")}</h2></Reveal>
      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        {items.map((it, i) => (
          <Reveal key={it.t} delay={i * 90}>
            <div className="lift h-full rounded-2xl border border-line bg-surface p-5">
              <span className="grid h-11 w-11 place-items-center rounded-xl bg-brand-tint text-brand"><it.icon className="h-5 w-5" /></span>
              <h3 className="mt-4 font-semibold text-ink">{it.t}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted">{it.d}</p>
            </div>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

/* ── WhatsApp booking + live demo ──────────────────────────────────────────── */
function WhatsAppSection() {
  const features = [
    "Instant booking confirmation",
    "Cancellation and reschedule updates",
    "Day-before reminders",
    "Missed a slot? Auto-moved to the next working day",
    "“Is the doctor in?” answered any time",
  ];
  return (
    <section id="whatsapp" className="scroll-mt-16 border-y border-line bg-brand-tint/25">
      <div className="mx-auto grid max-w-6xl grid-cols-1 items-center gap-8 px-5 md:gap-12 md:px-8 py-12 md:py-24 lg:grid-cols-2">
        <Reveal>
          <div>
            <span className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-2.5 py-1 text-[12px] font-medium text-[#075E54] md:px-3 md:py-1.5 md:text-[13px]">
              <MessageCircle className="h-3.5 w-3.5 md:h-4 md:w-4" /> WhatsApp booking
            </span>
            <h2 className="mt-4 text-2xl font-semibold md:mt-5 md:text-4xl">Book on WhatsApp, in your language.</h2>
            <p className="mt-3 max-w-md text-[14px] leading-relaxed text-muted md:mt-4 md:text-base">
              Patients message the clinic just like they message anyone. The assistant checks if the doctor is in, books a slot and sends a token, in Telugu, English or Hindi.
            </p>
            <ul className="mt-5 space-y-2 md:mt-6 md:space-y-2.5">
              {features.map((f) => (
                <li key={f} className="flex items-center gap-2.5 text-[14px] md:text-[15px]">
                  <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-[#075E54] text-white"><Check className="h-3 w-3" /></span>
                  {f}
                </li>
              ))}
            </ul>
            <a href={waLink("Hi, I would like to book an appointment with Dr. Ramachandra.")} target="_blank" rel="noreferrer" className="press mt-6 inline-flex items-center gap-2 rounded-full bg-[#075E54] px-5 py-3 text-[14px] font-semibold text-white transition hover:brightness-110 md:mt-7 md:px-6 md:py-3.5 md:text-[15px]">
              <MessageCircle className="h-[18px] w-[18px]" /> Open WhatsApp
            </a>
            <p className="mt-3 text-xs text-muted">Try the live demo yourself. It really books into the clinic dashboard.</p>
          </div>
        </Reveal>
        <Reveal delay={120}>
          <WhatsAppDemo />
        </Reveal>
      </div>
    </section>
  );
}

/* ── Services ────────────────────────────────────────────────────────────── */
function Services({ t }: { t: T }) {
  return (
    <section id="services" className="mx-auto max-w-6xl scroll-mt-16 px-5 md:px-8 py-12 md:py-24">
      <Reveal><SectionHead n="01" title={t("sec.services")} /></Reveal>
      <div className="mt-10 space-y-8">
        {serviceGroups.map((g) => (
          <div key={g.group}>
            <h3 className="text-sm font-semibold uppercase tracking-wider text-muted">{g.group}</h3>
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {g.items.map((s, i) => {
                const Ic = iconMap[s.icon] ?? Activity;
                return (
                  <Reveal key={s.name} delay={(i % 4) * 60}>
                    <div className="lift group flex h-full items-center gap-3 rounded-2xl border border-line bg-surface p-4">
                      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-tint text-brand transition group-hover:bg-brand group-hover:text-white"><Ic className="h-5 w-5" /></span>
                      <span className="text-sm font-medium leading-tight">{s.name}</span>
                    </div>
                  </Reveal>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ── Reviews ─────────────────────────────────────────────────────────────── */
function Reviews({ t }: { t: T }) {
  return (
    <section id="reviews" className="scroll-mt-16 border-y border-line bg-brand-tint/30">
      <div className="mx-auto max-w-6xl px-5 md:px-8 py-12 md:py-24">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <Reveal><SectionHead n="02" title={t("sec.reviews")} /></Reveal>
          <Reveal delay={80}>
            <div className="flex items-center gap-2"><Stars n={5} /><span className="font-semibold">{clinic.rating.score}</span><span className="text-sm text-muted">· {clinic.rating.count} {clinic.rating.source} reviews</span></div>
          </Reveal>
        </div>
        <div className="mt-10 columns-1 gap-4 sm:columns-2 lg:columns-3">
          {reviews.map((r, i) => (
            <Reveal key={r.name} delay={(i % 3) * 80} className="mb-4 inline-block w-full break-inside-avoid align-top">
              <figure className="lift rounded-2xl border border-line bg-surface p-5">
                <Quote className="h-5 w-5 text-accent" />
                <blockquote className="mt-2 text-[14px] leading-relaxed text-ink/90">{r.text}</blockquote>
                <figcaption className="mt-4 flex items-center gap-3">
                  <span className="grid h-9 w-9 place-items-center rounded-full bg-brand-tint text-sm font-semibold text-brand">{r.name[0].toUpperCase()}</span>
                  <span className="min-w-0"><span className="block truncate text-sm font-semibold">{r.name}</span><span className="block text-xs text-muted">{r.when}</span></span>
                  <Stars n={5} className="ml-auto" small />
                </figcaption>
              </figure>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ── Doctor strip ────────────────────────────────────────────────────────── */
function DoctorStrip({ t }: { t: T }) {
  return (
    <section className="mx-auto max-w-6xl px-5 md:px-8 py-12 md:py-20">
      <Reveal>
        <div className="grid grid-cols-1 items-center gap-6 rounded-3xl border border-line bg-surface p-6 md:grid-cols-12 md:gap-8 md:p-12">
          <div className="md:col-span-4 flex md:justify-center">
            <div className="relative">
              <DoctorPhoto className="h-28 w-28 rounded-3xl text-3xl md:h-36 md:w-36 md:text-4xl" />
              <span className="absolute -bottom-2 -right-2 flex items-center gap-1 rounded-full bg-surface px-2.5 py-1 text-xs font-semibold shadow-soft"><Star className="h-3.5 w-3.5 fill-accent text-accent" /> {clinic.rating.score}</span>
            </div>
          </div>
          <div className="md:col-span-8">
            <span className="text-sm font-semibold uppercase tracking-wider text-muted">{t("sec.doctor")}</span>
            <h2 className="mt-2 text-2xl font-semibold md:text-3xl">{clinic.doctor.name}</h2>
            <p className="mt-1 text-brand font-medium">{clinic.doctor.title}</p>
            <p className="mt-4 max-w-xl leading-relaxed text-muted">{clinic.doctor.experienceNote}. Patients across Visakhapatnam trust Dr. Ramachandra for clear explanations, unhurried consultations and honest advice, from a hairline fracture to a full joint replacement.</p>
            <div className="mt-5 flex flex-wrap gap-2">
              {["10 years experience", "Fractures", "Knee replacement", "Sports injuries", "Trauma care", "Physiotherapy"].map((s) => (
                <span key={s} className="rounded-full bg-brand-tint px-3 py-1 text-xs font-medium text-brand">{s}</span>
              ))}
            </div>
          </div>
        </div>
      </Reveal>
    </section>
  );
}

/* ── Location + hours ────────────────────────────────────────────────────── */
function LocationHours({ t }: { t: T }) {
  return (
    <section id="location" className="mx-auto grid max-w-6xl scroll-mt-16 gap-8 px-5 md:px-8 pb-12 md:pb-24 lg:grid-cols-2">
      <Reveal>
        <SectionHead n="03" title={t("sec.location")} />
        <div className="lift mt-8 rounded-3xl border border-line bg-surface p-6">
          <div className="flex items-start gap-3">
            <MapPin className="mt-0.5 h-5 w-5 shrink-0 text-brand" />
            <address className="not-italic text-[15px] leading-relaxed">{clinic.location.line1}<br />{clinic.location.line2}<br />{clinic.location.city}, {clinic.location.state} {clinic.location.pin}</address>
          </div>
          <a href={clinic.location.mapsUrl} target="_blank" rel="noreferrer" className="press mt-5 inline-flex items-center gap-2 rounded-full bg-brand px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-dark"><Navigation className="h-4 w-4" /> {t("loc.directions")}</a>

          <div className="mt-6 space-y-2.5 border-t border-line pt-5">
            <a href={`tel:${clinic.contact.landline}`} className="ulink flex items-center gap-3 text-[15px]">
              <Phone className="h-4 w-4 shrink-0 text-brand" /> {clinic.contact.landline.replace("+91", "0")}
              <span className="text-xs text-muted">Clinic landline</span>
            </a>
            <a href={`tel:${clinic.contact.phone}`} className="ulink flex items-center gap-3 text-[15px]">
              <MessageCircle className="h-4 w-4 shrink-0 text-brand" /> {clinic.contact.phone.replace("+91", "")}
              <span className="text-xs text-muted">Mobile / WhatsApp</span>
            </a>
            <a href={`tel:${clinic.contact.emergency}`} className="ulink flex items-center gap-3 text-[15px]">
              <TriangleAlert className="h-4 w-4 shrink-0 text-brand" /> {clinic.contact.emergency.replace("+91", "")}
              <span className="text-xs text-muted">Emergency only</span>
            </a>
          </div>
        </div>
      </Reveal>
      <Reveal delay={100}>
        <SectionHead n="04" title={t("sec.hours")} />
        <div className="mt-8 rounded-3xl border border-line bg-surface p-6">
          <ul className="divide-y divide-line">
            {DAYS.map((d) => {
              const wins = weeklyHours[dayIdx(d)] ?? [];
              const today = weekdayName(new Date()) === d;
              return (
                <li key={d} className={`flex items-center justify-between py-2.5 text-sm ${today ? "font-semibold text-ink" : "text-muted"}`}>
                  <span className="flex items-center gap-2">{today && <span className="h-1.5 w-1.5 rounded-full bg-in" />}{d}</span>
                  <span className="text-right">{wins.length ? wins.map((w) => `${fmt(w.start)} – ${fmt(w.end)}`).join(", ") : "Closed"}</span>
                </li>
              );
            })}
          </ul>
          <p className="mt-4 text-xs text-muted">Closed Sundays. Check the live status at the top before visiting.</p>
        </div>
      </Reveal>
    </section>
  );
}

/* ── Footer (clinic only) ────────────────────────────────────────────────── */
function Footer({ t }: { t: T }) {
  return (
    <footer className="border-t border-line bg-ink text-white/75">
      <div className="mx-auto grid max-w-6xl gap-8 px-5 md:px-8 py-14 sm:grid-cols-2 lg:grid-cols-4">
        <div className="sm:col-span-2">
          <div className="flex items-center gap-2.5"><span className="grid h-8 w-8 place-items-center rounded-lg bg-brand text-white"><Bone className="h-[18px] w-[18px]" /></span><span className="text-lg font-semibold text-white">{clinic.name}</span></div>
          <p className="mt-3 max-w-xs text-sm text-white/55">{clinic.tagline}</p>
          <div className="mt-4 flex items-center gap-2 text-sm"><Star className="h-4 w-4 fill-accent text-accent" /><span className="text-white">{clinic.rating.score}</span><span className="text-white/50">· {clinic.rating.count} reviews</span></div>
        </div>
        <div className="text-sm">
          <div className="font-semibold text-white">Visit</div>
          <p className="mt-3 text-white/55">{clinic.location.line2}<br />{clinic.location.city} {clinic.location.pin}</p>
          <a href={clinic.location.mapsUrl} target="_blank" rel="noreferrer" className="ulink mt-2 inline-block text-white/75">{t("loc.directions")}</a>
        </div>
        <div className="text-sm">
          <div className="font-semibold text-white">Get in touch</div>
          <div className="mt-3 flex flex-col gap-1.5">
            <Link href="/book" className="ulink text-white/75">{t("cta.book")}</Link>
            <a href={waLink("Hi, I would like to book an appointment.")} target="_blank" rel="noreferrer" className="ulink text-white/75">{t("cta.whatsapp")}</a>
            <a href={`tel:${clinic.contact.phone}`} className="ulink text-white/75">{t("cta.call")}</a>
          </div>
        </div>
      </div>
      <div className="border-t border-white/10">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-1 px-5 md:px-8 py-4 pb-24 text-xs text-white/35 md:pb-4">
          <span>© {new Date().getFullYear()} {clinic.name}. {clinic.location.city}, {clinic.location.state}.</span>
          <Link href="/privacy" className="ulink text-white/45 hover:text-white/70">Privacy &amp; appointment policy</Link>
        </div>
      </div>
    </footer>
  );
}

/* ── Mobile sticky action bar ────────────────────────────────────────────── */
function MobileBar({ t }: { t: T }) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-50 border-t border-line bg-bg/90 px-3 py-2 backdrop-blur-md md:hidden" style={{ paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))" }}>
      <div className="flex gap-2">
        <Link href="/book" className="press flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-brand px-2 py-2.5 text-[13px] font-semibold text-white"><CalendarPlus className="h-4 w-4 shrink-0" /> {t("cta.bookShort")}</Link>
        <a href={waLink("Hi, I would like to book an appointment.")} target="_blank" rel="noreferrer" className="press flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-full border border-brand/25 bg-surface px-2 py-2.5 text-[13px] font-semibold text-brand"><MessageCircle className="h-4 w-4 shrink-0" /> WhatsApp</a>
      </div>
    </div>
  );
}

/* ── shared ──────────────────────────────────────────────────────────────── */
function Reveal({ children, delay = 0, className = "" }: { children: ReactNode; delay?: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { el.classList.add("in"); io.disconnect(); } }, { threshold: 0.12, rootMargin: "0px 0px -40px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return <div ref={ref} className={`reveal ${className}`} style={{ transitionDelay: `${delay}ms` }}>{children}</div>;
}

function SectionHead({ n, title }: { n: string; title: string }) {
  return (
    <div>
      <span className="font-mono text-xs text-accent">/{n}</span>
      <h2 className="mt-1 text-2xl font-semibold md:mt-1.5 md:text-4xl">{title}</h2>
    </div>
  );
}

function Stars({ n, className = "", small = false }: { n: number; className?: string; small?: boolean }) {
  return (
    <span className={`inline-flex ${className}`}>
      {Array.from({ length: n }).map((_, i) => (
        <Star key={i} className={`${small ? "h-3.5 w-3.5" : "h-4 w-4"} fill-accent text-accent`} />
      ))}
    </span>
  );
}
