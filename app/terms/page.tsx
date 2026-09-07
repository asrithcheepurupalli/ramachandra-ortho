import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, FileText, MessageCircle, Phone, Mail, Ticket } from "lucide-react";
import { clinic } from "@/clinic.config";

const title = "Terms & Conditions";
const description = `The terms ${clinic.name}'s website, booking tool and online payments are provided under.`;

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/terms" },
  openGraph: { title: `${title} · ${clinic.shortName}`, description, url: `${clinic.url}/terms` },
  twitter: { title: `${title} · ${clinic.shortName}`, description },
};

const waLink = (msg: string) =>
  `https://wa.me/${clinic.contact.whatsapp.replace(/\D/g, "")}?text=${encodeURIComponent(msg)}`;

// Bump this whenever the terms text below actually changes, same convention
// as app/privacy/page.tsx's LAST_UPDATED.
const LAST_UPDATED = new Date("2026-09-07");
const lastUpdatedLabel = LAST_UPDATED.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-line py-7 first:border-t-0 first:pt-0">
      <h2 className="font-display text-lg text-ink">{title}</h2>
      <div className="mt-3 space-y-2.5 text-[15px] leading-relaxed text-muted">{children}</div>
    </section>
  );
}

export default function TermsPage() {
  return (
    <main className="mx-auto w-full max-w-2xl px-5 pb-24 pt-6 md:pb-16">
      <Link href="/" className="press inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
        <ArrowLeft className="h-4 w-4 shrink-0" /> {clinic.shortName}
      </Link>

      <div className="mt-6 flex items-center gap-2.5">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand-tint text-brand">
          <FileText className="h-[18px] w-[18px]" />
        </span>
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Terms &amp; Conditions</h1>
      </div>
      <p className="mt-3 text-[15px] text-muted">
        Last updated {lastUpdatedLabel}. By using this website or booking a token through it, you agree to the
        terms below. Our token and appointment policy, and how we handle your information, are covered separately
        on the <Link href="/privacy" className="font-medium text-brand underline underline-offset-2">privacy &amp; appointment policy</Link> page.
      </p>

      <div className="mt-2">
        <Section title="What this website is">
          <p>This site is a booking tool for {clinic.name}, a physical clinic in {clinic.location.city}. It lets you reserve a token and reach the front desk on WhatsApp or by phone.</p>
          <p>Nothing on this site, or in anything our WhatsApp assistant sends, is medical advice or a diagnosis. It doesn&rsquo;t replace an in person consultation with the doctor.</p>
        </Section>

        <Section title="Booking &amp; tokens">
          <p>A booking made here is a request for a token for a given day, not a guaranteed fixed time slot. The exact time is confirmed back to you on WhatsApp once the front desk checks it against that day&rsquo;s schedule.</p>
          <p>We can reschedule or reassign tokens if the doctor is unavailable, running late, or the clinic is closed for an emergency, and we&rsquo;ll let you know on WhatsApp when that happens.</p>
        </Section>

        <Section title="Online payments">
          <p>
            Where the consultation fee is paid online through this site or a WhatsApp payment link, the payment is
            processed by Razorpay, a third party payment gateway, under Razorpay&rsquo;s own terms. We never see or
            store your card, UPI or bank details.
          </p>
          <p>
            A paid fee is adjusted against your visit. If your appointment is cancelled by the clinic, or you cancel
            with reasonable notice, message us on WhatsApp or call and we&rsquo;ll arrange a refund to the original
            payment method.
          </p>
        </Section>

        <Section title="Your responsibilities">
          <p>Give us accurate contact details and reason for visit, so we can reach you and the doctor is prepared.</p>
          <p>Don&rsquo;t use this site or our WhatsApp number to send abusive, fraudulent or spam messages, or to book tokens you don&rsquo;t intend to use.</p>
        </Section>

        <Section title="No warranty, limited liability">
          <p>
            We keep this site and our WhatsApp assistant running carefully, but we don&rsquo;t guarantee they&rsquo;ll
            be error free or available every minute. If a slot shown as open turns out to be taken, or a message is
            delayed, we&rsquo;ll do our best to fix it quickly, call the clinic if a booking is urgent.
          </p>
          <p>
            To the extent the law allows, {clinic.name} isn&rsquo;t liable for indirect loss arising from using this
            site, beyond refunding a payment actually made through it.
          </p>
        </Section>

        <Section title="Changes to these terms">
          <p>We may update these terms as the clinic&rsquo;s booking process or payment setup changes. The &ldquo;last updated&rdquo; date above always reflects the current version.</p>
        </Section>

        <Section title="Governing law">
          <p>These terms are governed by the laws of India, and any dispute is subject to the courts of {clinic.location.city}, {clinic.location.state}.</p>
        </Section>

        <Section title="Questions">
          <p>Reach out anytime, we&rsquo;re happy to explain any of this in more detail.</p>
          <div className="mt-3 flex flex-wrap gap-2.5">
            <a href={waLink("Hi, I have a question about the terms on your website.")} target="_blank" rel="noreferrer"
              className="press inline-flex items-center gap-1.5 rounded-full bg-brand px-4 py-2 text-sm font-medium text-white">
              <MessageCircle className="h-4 w-4" /> WhatsApp us
            </a>
            <a href={`tel:${clinic.contact.phone}`}
              className="press inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-4 py-2 text-sm font-medium text-ink">
              <Phone className="h-4 w-4" /> Call the clinic
            </a>
            <a href={`mailto:${clinic.contact.email}`}
              className="press inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-4 py-2 text-sm font-medium text-ink">
              <Mail className="h-4 w-4" /> Email us
            </a>
          </div>
        </Section>
      </div>

      <Link href="/book" className="press mt-8 inline-flex items-center gap-1.5 text-sm font-medium text-brand">
        <Ticket className="h-4 w-4" /> Book an appointment
      </Link>
    </main>
  );
}
