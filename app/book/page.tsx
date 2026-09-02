import type { Metadata } from "next";
import { clinic } from "@/clinic.config";
import { BookForm } from "@/components/BookForm";

export const metadata: Metadata = {
  title: "Book an Appointment",
  description: `Book a token online with ${clinic.doctor.name} in ${clinic.location.city} — pick an open day and time, or switch to WhatsApp anytime.`,
  alternates: { canonical: "/book" },
};

export default function BookPage() {
  return <BookForm />;
}
