"use client";

// Placeholder shell — the full slot-picker booking flow is the next build step.
// Kept on-brand and functional (WhatsApp / call) so the CTA is never a dead end.
import Link from "next/link";
import { ArrowLeft, MessageCircle, Phone } from "lucide-react";
import { clinic } from "@/clinic.config";

const wa = `https://wa.me/${clinic.contact.whatsapp.replace(/\D/g, "")}?text=${encodeURIComponent(
  "Hi, I would like to book an appointment with Dr. Ramachandra."
)}`;

export default function BookPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-5 py-16">
      <Link href="/" className="mb-8 inline-flex items-center gap-2 text-sm text-muted hover:text-ink">
        <ArrowLeft className="h-4 w-4" /> Back
      </Link>
      <span className="font-mono text-xs text-accent">/ book</span>
      <h1 className="mt-2 font-display text-4xl tracking-[-0.01em] text-ink">
        Book an appointment<span className="text-accent">.</span>
      </h1>
      <p className="mt-4 text-muted">
        The slot picker and instant WhatsApp confirmation are being wired up. For now,
        reserve your spot in one tap:
      </p>
      <div className="mt-8 flex flex-col gap-3">
        <a href={wa} target="_blank" rel="noreferrer" className="inline-flex items-center justify-center gap-2 rounded-full bg-brand px-6 py-4 font-semibold text-white transition hover:bg-brand-dark">
          <MessageCircle className="h-5 w-5" /> Chat on WhatsApp
        </a>
        <a href={`tel:${clinic.contact.phone}`} className="inline-flex items-center justify-center gap-2 rounded-full border border-line bg-white px-6 py-4 font-semibold text-ink transition hover:border-brand/40">
          <Phone className="h-5 w-5 text-brand" /> Call the clinic
        </a>
      </div>
    </main>
  );
}
