import type { Metadata } from "next";
import { clinic } from "@/clinic.config";
import { MyAppointment } from "@/components/MyAppointment";

const title = "My Appointment";
const description = `Look up your booking with ${clinic.doctor.name}, view its status, reschedule it, or cancel it, using the phone number you booked with.`;

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/my-appointment" },
  openGraph: { title: `${title} · ${clinic.shortName}`, description, url: `${clinic.url}/my-appointment` },
  twitter: { title: `${title} · ${clinic.shortName}`, description },
};

export default function MyAppointmentPage() {
  return <MyAppointment />;
}
