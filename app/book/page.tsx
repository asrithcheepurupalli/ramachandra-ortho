import type { Metadata } from "next";
import { clinic } from "@/clinic.config";
import { BookForm } from "@/components/BookForm";

const title = "Book an Appointment";
const description = `Book a token online with ${clinic.doctor.name} in ${clinic.location.city}. Pick an open day and time, or switch to WhatsApp anytime.`;

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/book" },
  openGraph: { title: `${title} · ${clinic.shortName}`, description, url: `${clinic.url}/book` },
  twitter: { title: `${title} · ${clinic.shortName}`, description },
};

export default function BookPage() {
  return <BookForm />;
}
