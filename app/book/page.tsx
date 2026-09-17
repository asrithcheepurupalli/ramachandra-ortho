import type { Metadata } from "next";
import { clinic } from "@/clinic.config";
import { BookForm } from "@/components/BookForm";

const title = "Book an Appointment Online";
const description = `Book your orthopedic consultation token with ${clinic.doctor.name} in ${clinic.location.city}. Choose date and time slot with instant token confirmation.`;

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/book" },
  openGraph: {
    title: `${title} · ${clinic.shortName}`,
    description,
    url: `${clinic.url}/book`,
    images: [{ url: "/clinic-reception.jpg", width: 1200, height: 800, alt: "Book Appointment — Ramachandra Ortho Care" }],
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
          name: "Book Appointment",
          item: `${clinic.url}/book`,
        },
      ],
    },
    {
      "@type": "MedicalWebPage",
      "@id": `${clinic.url}/book`,
      url: `${clinic.url}/book`,
      name: `Book Consultation with ${clinic.doctor.name}`,
      description,
      isPartOf: { "@id": `${clinic.url}/#website` },
      about: { "@id": `${clinic.url}/#clinic` },
      potentialAction: {
        "@type": "ReserveAction",
        target: {
          "@type": "EntryPoint",
          urlTemplate: `${clinic.url}/book`,
          actionPlatform: [
            "http://schema.org/DesktopWebPlatform",
            "http://schema.org/MobileWebPlatform",
          ],
        },
        result: {
          "@type": "Reservation",
          name: "Book Orthopedic Appointment Token",
        },
      },
    },
  ],
};

export default function BookPage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <BookForm />
    </>
  );
}
