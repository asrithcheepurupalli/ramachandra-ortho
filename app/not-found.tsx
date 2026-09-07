import Link from "next/link";
import { Compass, MessageCircle, Ticket } from "lucide-react";
import { clinic } from "@/clinic.config";

const waLink = (msg: string) =>
  `https://wa.me/${clinic.contact.whatsapp.replace(/\D/g, "")}?text=${encodeURIComponent(msg)}`;

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-[80vh] w-full max-w-md flex-col items-center justify-center px-5 pb-24 pt-6 text-center md:pb-16">
      <span className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-brand-tint text-brand">
        <Compass className="h-6 w-6" />
      </span>
      <h1 className="mt-5 text-2xl font-semibold tracking-tight md:text-3xl">Page not found</h1>
      <p className="mt-2.5 text-[15px] leading-relaxed text-muted">
        That page doesn&rsquo;t exist, or the link&rsquo;s out of date. Let&rsquo;s get you back to booking a token
        with {clinic.doctor.name}.
      </p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-2.5">
        <Link href="/book" className="press inline-flex items-center gap-1.5 rounded-full bg-brand px-5 py-2.5 text-sm font-semibold text-white">
          <Ticket className="h-4 w-4" /> Book an appointment
        </Link>
        <a href={waLink("Hi, I was trying to find something on your website.")} target="_blank" rel="noreferrer"
          className="press inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-5 py-2.5 text-sm font-semibold text-ink">
          <MessageCircle className="h-4 w-4 text-brand" /> WhatsApp us
        </a>
      </div>
      <Link href="/" className="press mt-6 text-sm font-medium text-muted hover:text-ink">
        ← Back to {clinic.shortName}
      </Link>
    </main>
  );
}
