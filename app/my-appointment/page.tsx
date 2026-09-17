import type { Metadata } from "next";
import { clinic } from "@/clinic.config";
import { MyAppointment } from "@/components/MyAppointment";

const title = "My Appointment — View, Reschedule or Pay";
const description = `Look up your booking with ${clinic.doctor.name}, check your token number, reschedule date or pay online using your phone number.`;

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/my-appointment" },
  openGraph: {
    title: `${title} · ${clinic.shortName}`,
    description,
    url: `${clinic.url}/my-appointment`,
    images: [{ url: "/clinic-reception.jpg", width: 1200, height: 800, alt: "My Appointment — Ramachandra Ortho Care" }],
  },
  twitter: {
    card: "summary_large_image",
    title: `${title} · ${clinic.shortName}`,
    description,
    images: ["/clinic-reception.jpg"],
  },
};

const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "BreadcrumbList",
      itemListElement: [
        {
          "@type": "ListItem",
          position: 1,
          name: "Home",
          item: clinic.url,
        },
        {
          "@type": "ListItem",
          position: 2,
          name: "My Appointment",
          item: `${clinic.url}/my-appointment`,
        },
      ],
    },
    {
      "@type": "WebPage",
      "@id": `${clinic.url}/my-appointment`,
      url: `${clinic.url}/my-appointment`,
      name: "Appointment Self-Service Portal",
      description,
      isPartOf: { "@id": `${clinic.url}/#website` },
      about: { "@id": `${clinic.url}/#clinic` },
    },
  ],
};

export default function MyAppointmentPage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <MyAppointment />
    </>
  );
}
