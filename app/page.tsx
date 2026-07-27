"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Activity, Ambulance, Bone, CircleDot, Droplet, Dumbbell, HandHeart,
  PersonStanding, ShieldPlus, Siren, Spline, Stethoscope, Volleyball,
  Star, MapPin, MessageCircle, CalendarPlus, Phone, Clock, ChevronRight,
  ArrowRight, Navigation, Quote, type LucideIcon,
} from "lucide-react";
import { clinic, type Lang } from "@/clinic.config";
import { tr, langLabels } from "@/lib/i18n";
import { serviceGroups } from "@/lib/services";
import { reviews } from "@/lib/reviews";
import { weeklyHours, statusAt, fmt, weekdayName, type Status } from "@/lib/schedule";

const iconMap: Record<string, LucideIcon> = {
  Bone, PersonStanding, Activity, Spline, Volleyball, Ambulance, Dumbbell,
  HandHeart, Siren, Stethoscope, ShieldPlus, Droplet, CircleDot,
};

const waLink = (msg: string) =>
  `https://wa.me/${clinic.contact.whatsapp.replace(/\D/g, "")}?text=${encodeURIComponent(msg)}`;

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const dayIdx = (name: string) => (name === "Sunday" ? 0 : DAYS.indexOf(name) + 1);

export default function Home() {
  const [lang, setLang] = useState<Lang>("en");
  const [status, setStatus] = useState<Status | null>(null);
  const t = (k: string, v?: Record<string, string | number>) => tr(lang, k, v);

  // Compute availability on the client so the banner reflects real time
  // without a hydration mismatch.
  useEffect(() => {
    setStatus(statusAt());
    const id = setInterval(() => setStatus(statusAt()), 60_000);
    return () => clearInterval(id);
  }, []);

  return (
    <>
      <Nav lang={lang} setLang={setLang} t={t} />

      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <header className="relative overflow-hidden border-b border-line">
        <div className="absolute inset-0 bone-grid opacity-70" aria-hidden />
        <div className="absolute -top-24 -right-24 h-96 w-96 rounded-full bg-brand-tint blur-3xl opacity-60" aria-hidden />
        <div className="relative mx-auto max-w-6xl px-5 md:px-8 pt-14 md:pt-20 pb-14 grid lg:grid-cols-12 gap-10 items-center">
          <div className="lg:col-span-7">
            <span className="rise inline-flex items-center gap-2 text-[13px] font-medium tracking-wide text-brand">
              <span className="h-1.5 w-1.5 rounded-full bg-accent" />
              {t("hero.kicker")}
            </span>
            <h1 className="rise mt-5 font-display text-[2.6rem] leading-[1.02] md:text-6xl tracking-[-0.02em] text-ink" style={{ animationDelay: "0.05s" }}>
              {clinic.shortName}
              <span className="text-accent">.</span>
            </h1>
            <p className="rise mt-5 max-w-xl text-[17px] md:text-lg leading-relaxed text-muted" style={{ animationDelay: "0.12s" }}>
              {t("hero.subtitle")}
            </p>

            <div className="rise mt-7" style={{ animationDelay: "0.18s" }}>
              <AvailabilityBanner status={status} t={t} />
            </div>

            <div className="rise mt-7 flex flex-wrap items-center gap-3" style={{ animationDelay: "0.24s" }}>
              <Link href="/book" className="group inline-flex items-center gap-2 rounded-full bg-brand px-6 py-3.5 text-[15px] font-semibold text-white shadow-sm transition hover:bg-brand-dark hover:-translate-y-0.5">
                <CalendarPlus className="h-[18px] w-[18px]" /> {t("cta.book")}
                <ArrowRight className="h-4 w-4 transition group-hover:translate-x-0.5" />
              </Link>
              <a href={waLink("Hi, I would like to book an appointment with Dr. Ramachandra.")} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-full border border-brand/25 bg-white px-6 py-3.5 text-[15px] font-semibold text-brand transition hover:border-brand/50 hover:-translate-y-0.5">
                <MessageCircle className="h-[18px] w-[18px]" /> {t("cta.whatsapp")}
              </a>
            </div>

            <div className="rise mt-7 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm" style={{ animationDelay: "0.3s" }}>
              <span className="inline-flex items-center gap-1.5 text-ink">
                <Stars n={5} />
                <span className="font-semibold">{clinic.rating.score}</span>
                <span className="text-muted">· {clinic.rating.count} {clinic.rating.source} reviews</span>
              </span>
              <span className="text-muted">·</span>
              <span className="text-ink">{t("fee.line", { cur: clinic.currency, fee: clinic.consultationFee })}</span>
            </div>
          </div>

          {/* Doctor card */}
          <div className="rise lg:col-span-5" style={{ animationDelay: "0.2s" }}>
            <div className="rounded-3xl border border-line bg-paper p-6 shadow-[0_20px_60px_-30px_rgba(14,90,78,0.35)]">
              <div className="flex items-center gap-4">
                <div className="grid h-16 w-16 shrink-0 place-items-center rounded-2xl bg-brand text-white font-display text-2xl">
                  MR
                </div>
                <div>
                  <div className="font-display text-xl text-ink">{clinic.doctor.name}</div>
                  <div className="text-sm text-muted">{clinic.doctor.title}</div>
                </div>
              </div>
              <p className="mt-4 text-sm leading-relaxed text-muted">
                {clinic.doctor.experienceNote}. {t("walkin.note")}
              </p>
              <div className="mt-4 flex flex-wrap gap-1.5">
                {["Fractures", "Joint replacement", "Sports injuries", "Trauma"].map((s) => (
                  <span key={s} className="rounded-full bg-brand-tint px-3 py-1 text-xs font-medium text-brand">{s}</span>
                ))}
              </div>
              <a href={`tel:${clinic.contact.phone}`} className="mt-5 flex items-center justify-center gap-2 rounded-xl border border-line py-2.5 text-sm font-medium text-ink transition hover:border-brand/40">
                <Phone className="h-4 w-4 text-brand" /> {t("cta.call")}
              </a>
            </div>
          </div>
        </div>
      </header>

      {/* ── Services ─────────────────────────────────────────────────────── */}
      <section id="services" className="mx-auto max-w-6xl px-5 md:px-8 py-16 md:py-24">
        <SectionHead label="01" title={t("sec.services")} />
        <div className="mt-10 space-y-10">
          {serviceGroups.map((g) => (
            <div key={g.group}>
              <h3 className="text-sm font-semibold uppercase tracking-wider text-muted">{g.group}</h3>
              <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                {g.items.map((s) => {
                  const Ic = iconMap[s.icon] ?? Activity;
                  return (
                    <div key={s.name} className="group flex items-center gap-3 rounded-2xl border border-line bg-paper p-4 transition hover:border-brand/30 hover:-translate-y-0.5">
                      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-tint text-brand transition group-hover:bg-brand group-hover:text-white">
                        <Ic className="h-5 w-5" />
                      </span>
                      <span className="text-sm font-medium leading-tight text-ink">{s.name}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Reviews wall ─────────────────────────────────────────────────── */}
      <section id="reviews" className="border-y border-line bg-brand-tint/40">
        <div className="mx-auto max-w-6xl px-5 md:px-8 py-16 md:py-24">
          <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
            <SectionHead label="02" title={t("sec.reviews")} />
            <div className="flex items-center gap-2 text-ink">
              <Stars n={5} />
              <span className="font-semibold">{clinic.rating.score}</span>
              <span className="text-sm text-muted">· {clinic.rating.count} {clinic.rating.source} reviews</span>
            </div>
          </div>
          <div className="mt-10 columns-1 sm:columns-2 lg:columns-3 gap-4">
            {reviews.map((r) => (
              <figure key={r.name} className="mb-4 break-inside-avoid rounded-2xl border border-line bg-paper p-5">
                <Quote className="h-5 w-5 text-accent/70" />
                <blockquote className="mt-2 text-[14px] leading-relaxed text-ink/90">{r.text}</blockquote>
                <figcaption className="mt-4 flex items-center gap-3">
                  <span className="grid h-9 w-9 place-items-center rounded-full bg-brand-tint text-sm font-semibold text-brand">
                    {r.name[0].toUpperCase()}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold text-ink">{r.name}</span>
                    <span className="block text-xs text-muted">{r.when}</span>
                  </span>
                  <Stars n={5} className="ml-auto" small />
                </figcaption>
              </figure>
            ))}
          </div>
        </div>
      </section>

      {/* ── Location + hours ─────────────────────────────────────────────── */}
      <section id="location" className="mx-auto max-w-6xl px-5 md:px-8 py-16 md:py-24 grid lg:grid-cols-2 gap-10">
        <div>
          <SectionHead label="03" title={t("sec.location")} />
          <div className="mt-8 rounded-3xl border border-line bg-paper p-6">
            <div className="flex items-start gap-3">
              <MapPin className="mt-0.5 h-5 w-5 shrink-0 text-brand" />
              <address className="not-italic text-[15px] leading-relaxed text-ink">
                {clinic.location.line1}<br />
                {clinic.location.line2}<br />
                {clinic.location.city}, {clinic.location.state} {clinic.location.pin}
              </address>
            </div>
            <a href={clinic.location.mapsUrl} target="_blank" rel="noreferrer" className="mt-5 inline-flex items-center gap-2 rounded-full bg-brand px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-dark">
              <Navigation className="h-4 w-4" /> {t("loc.directions")}
            </a>
          </div>
        </div>
        <div>
          <SectionHead label="04" title={t("sec.hours")} />
          <div className="mt-8 rounded-3xl border border-line bg-paper p-6">
            <ul className="divide-y divide-line">
              {DAYS.map((d) => {
                const wins = weeklyHours[dayIdx(d)] ?? [];
                const today = weekdayName(new Date()) === d;
                return (
                  <li key={d} className={`flex items-center justify-between py-2.5 text-sm ${today ? "text-ink font-semibold" : "text-muted"}`}>
                    <span className="flex items-center gap-2">
                      {today && <span className="h-1.5 w-1.5 rounded-full bg-in" />}
                      {d}
                    </span>
                    <span className="text-right">
                      {d === "Saturday" ? "By appointment" : wins.length ? wins.map((w) => `${fmt(w.start)} – ${fmt(w.end)}`).join(", ") : "Closed"}
                    </span>
                  </li>
                );
              })}
            </ul>
            <p className="mt-4 flex items-center gap-2 text-xs text-muted">
              <Clock className="h-3.5 w-3.5" /> Saturdays vary. Check live availability above before visiting.
            </p>
          </div>
        </div>
      </section>

      <Footer t={t} />
    </>
  );
}

/* ── pieces ──────────────────────────────────────────────────────────────── */

function Nav({ lang, setLang, t }: { lang: Lang; setLang: (l: Lang) => void; t: (k: string) => string }) {
  return (
    <nav className="sticky top-0 z-50 border-b border-line bg-bone/85 backdrop-blur-md">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-5 md:px-8 h-16">
        <Link href="/" className="font-display text-lg md:text-xl text-ink leading-none">
          Ramachandra<span className="text-brand"> Ortho Care</span>
        </Link>
        <div className="flex items-center gap-1 md:gap-2">
          <div className="hidden md:flex items-center gap-1 mr-2">
            {[["services", "nav.services"], ["reviews", "nav.reviews"], ["location", "nav.location"]].map(([id, k]) => (
              <a key={id} href={`#${id}`} className="rounded-full px-3 py-2 text-sm text-muted transition hover:text-ink hover:bg-brand-tint/60">{t(k)}</a>
            ))}
          </div>
          <LangToggle lang={lang} setLang={setLang} />
          <Link href="/book" className="ml-1 inline-flex items-center gap-1.5 rounded-full bg-brand px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-dark">
            {t("nav.book")} <ChevronRight className="h-4 w-4" />
          </Link>
        </div>
      </div>
    </nav>
  );
}

function LangToggle({ lang, setLang }: { lang: Lang; setLang: (l: Lang) => void }) {
  return (
    <div className="flex items-center rounded-full border border-line bg-white p-0.5">
      {(Object.keys(langLabels) as Lang[]).map((l) => (
        <button
          key={l}
          onClick={() => setLang(l)}
          className={`rounded-full px-2.5 py-1 text-xs font-medium transition ${lang === l ? "bg-brand text-white" : "text-muted hover:text-ink"}`}
        >
          {langLabels[l]}
        </button>
      ))}
    </div>
  );
}

function AvailabilityBanner({ status, t }: { status: Status | null; t: (k: string, v?: Record<string, string | number>) => string }) {
  if (!status) {
    return <div className="inline-flex items-center gap-3 rounded-2xl border border-line bg-white px-4 py-3 text-sm text-muted">…</div>;
  }
  const map = {
    in: { color: "var(--color-in)", label: t("avail.in"), sub: status.state === "in" ? t("avail.until", { t: fmt(status.until) }) : "" },
    soon: { color: "var(--color-accent)", label: status.state === "soon" ? t("avail.soon", { t: fmt(status.opensAt) }) : "", sub: "" },
    out: {
      color: "var(--color-out)",
      label: t("avail.out"),
      sub: status.state === "out" && status.next ? t("avail.next", { day: weekdayName(status.next.date), t: fmt(status.next.opensAt) }) : "",
    },
  }[status.state];

  return (
    <div className="inline-flex items-center gap-3 rounded-2xl border border-line bg-white pl-4 pr-5 py-3">
      <span className="relative flex h-2.5 w-2.5">
        <span className="pulse-dot absolute inline-flex h-full w-full rounded-full" style={{ color: map.color }} />
        <span className="relative inline-flex h-2.5 w-2.5 rounded-full" style={{ background: map.color }} />
      </span>
      <span className="leading-tight">
        <span className="block text-[11px] font-medium uppercase tracking-wider text-muted">{t("avail.label")}</span>
        <span className="block text-[15px] font-semibold text-ink">
          {map.label}{map.sub && <span className="font-normal text-muted"> · {map.sub}</span>}
        </span>
      </span>
    </div>
  );
}

function SectionHead({ label, title }: { label: string; title: string }) {
  return (
    <div>
      <span className="font-mono text-xs text-accent">/{label}</span>
      <h2 className="mt-1 font-display text-3xl md:text-4xl tracking-[-0.01em] text-ink">{title}</h2>
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

function Footer({ t }: { t: (k: string) => string }) {
  return (
    <footer className="border-t border-line bg-ink text-white/80">
      <div className="mx-auto max-w-6xl px-5 md:px-8 py-12 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
        <div className="sm:col-span-2">
          <div className="font-display text-2xl text-white">{clinic.name}</div>
          <p className="mt-2 max-w-xs text-sm text-white/60">{clinic.tagline}</p>
        </div>
        <div className="text-sm">
          <div className="font-semibold text-white">Visit</div>
          <p className="mt-2 text-white/60">{clinic.location.line2}<br />{clinic.location.city} {clinic.location.pin}</p>
        </div>
        <div className="text-sm">
          <div className="font-semibold text-white">Book</div>
          <div className="mt-2 flex flex-col gap-1">
            <Link href="/book" className="text-white/60 hover:text-white">{t("cta.book")}</Link>
            <a href={waLink("Hi, I would like to book an appointment.")} target="_blank" rel="noreferrer" className="text-white/60 hover:text-white">{t("cta.whatsapp")}</a>
            <a href={`tel:${clinic.contact.phone}`} className="text-white/60 hover:text-white">{t("cta.call")}</a>
          </div>
        </div>
      </div>
      <div className="border-t border-white/10">
        <div className="mx-auto max-w-6xl px-5 md:px-8 py-4 text-xs text-white/40">
          © {new Date().getFullYear()} {clinic.name}. Built by made. by ac.
        </div>
      </div>
    </footer>
  );
}
