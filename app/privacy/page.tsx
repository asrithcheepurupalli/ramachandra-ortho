import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, ShieldCheck, MessageCircle, Phone, Mail, Ticket } from "lucide-react";
import { clinic } from "@/clinic.config";

export const metadata: Metadata = {
  title: "Privacy & Appointment Policy",
  description: `How ${clinic.name} collects, uses and protects your information when you book or message us, plus our token and appointment policy.`,
  alternates: { canonical: "/privacy" },
};

const waLink = (msg: string) =>
  `https://wa.me/${clinic.contact.whatsapp.replace(/\D/g, "")}?text=${encodeURIComponent(msg)}`;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-line py-7 first:border-t-0 first:pt-0">
      <h2 className="font-display text-lg text-ink">{title}</h2>
      <div className="mt-3 space-y-2.5 text-[15px] leading-relaxed text-muted">{children}</div>
    </section>
  );
}

export default function PrivacyPage() {
  return (
    <main className="mx-auto w-full max-w-2xl px-5 pb-24 pt-6 md:pb-16">
      <Link href="/" className="press inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
        <ArrowLeft className="h-4 w-4 shrink-0" /> {clinic.shortName}
      </Link>

      <div className="mt-6 flex items-center gap-2.5">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand-tint text-brand">
          <ShieldCheck className="h-[18px] w-[18px]" />
        </span>
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Privacy &amp; Appointment Policy</h1>
      </div>
      <p className="mt-3 text-[15px] text-muted">
        Last updated 2 September 2026. This page explains what {clinic.shortName} collects when you book or
        message us, how we use it, and the terms your token booking is made under. Plain language, no fine print
        surprises.
      </p>

      <div className="mt-2">
        <Section title="What we collect">
          <p>Your name and phone number, whenever you book, whether on this website, on WhatsApp, or through the WhatsApp appointment form.</p>
          <p>Your reason for visit, and anything you choose to share under &ldquo;anything the doctor should know.&rdquo;</p>
          <p>The messages you send us on WhatsApp, so our assistant and our front desk can reply and help with your booking.</p>
        </Section>

        <Section title="How we use it">
          <p>To hold your token, confirm your slot, and reach you if the day&rsquo;s schedule shifts.</p>
          <p>To help reception recognise returning patients and keep your visit history straight.</p>
          <p>That&rsquo;s it. We don&rsquo;t use your information for advertising, and we never sell it to anyone.</p>
        </Section>

        <Section title="WhatsApp and Meta">
          <p>
            When you message us on WhatsApp, that conversation runs on Meta&rsquo;s WhatsApp Business platform, the
            same infrastructure every business on WhatsApp uses to send and receive messages, subject to Meta&rsquo;s
            own privacy terms.
          </p>
          <p>
            Our WhatsApp appointment form is end to end encrypted between Meta and our server (industry standard
            RSA and AES encryption), so the details you fill in are never sent or stored in plain text.
          </p>
        </Section>

        <Section title="Where it&rsquo;s stored">
          <p>Bookings, patient records and the clinic schedule live in Supabase, a secure hosted database with encryption at rest.</p>
          <p>Only clinic staff we&rsquo;ve specifically approved can sign in and view this information, through a password protected staff dashboard.</p>
        </Section>

        <Section title="How long we keep it">
          <p>We keep your booking and visit information for as long as it&rsquo;s useful to your ongoing care and to the clinic&rsquo;s own records, in line with how any medical practice retains appointment history.</p>
        </Section>

        <Section title="Your rights">
          <p>You can ask us to correct, update or delete your information at any time, just call the clinic or message us on WhatsApp and we&rsquo;ll take care of it.</p>
        </Section>

        <Section title="Cookies">
          <p>The patient facing site doesn&rsquo;t use tracking or advertising cookies. The only cookie in play is a secure sign in cookie for clinic staff using the admin dashboard, nothing that follows patients around.</p>
        </Section>

        <Section title="Appointment &amp; token policy">
          <p>Booking a slot is a request for a token, not a fixed appointment time. We confirm the exact time back on WhatsApp once the front desk checks it against the day&rsquo;s actual schedule.</p>
          <p>Please arrive a few minutes before your preferred window.</p>
          <p>Miss your turn? No problem, it moves automatically to the next working day. No need to rebook.</p>
          <p>Plans changed? Message us on WhatsApp or call the clinic and we&rsquo;ll release your token for someone else.</p>
          <p>The consultation fee ({clinic.currency}{clinic.consultationFee}) is payable at the clinic, not online.</p>
        </Section>

        <Section title="Questions">
          <p>Reach out anytime, we&rsquo;re happy to explain any of this in more detail.</p>
          <div className="mt-3 flex flex-wrap gap-2.5">
            <a href={waLink("Hi, I have a question about my privacy or an appointment.")} target="_blank" rel="noreferrer"
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
