import type { Metadata, Viewport } from "next";
import { Geist } from "next/font/google";
import "./globals.css";
import { clinic } from "@/clinic.config";
import { weeklyHours, type Window } from "@/lib/schedule";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });

const title = `${clinic.name} · Orthopedic Surgeon in ${clinic.location.city}`;
const description = `${clinic.doctor.name}, ${clinic.doctor.title}, in ${clinic.location.line2}, ${clinic.location.city}. Fractures, joint replacements, sports injuries and trauma care. Check if the doctor is in today, book an appointment in seconds, or chat on WhatsApp. Rated ${clinic.rating.score}★ by ${clinic.rating.count} patients.`;

export const metadata: Metadata = {
  metadataBase: new URL(clinic.url),
  title: { default: title, template: `%s · ${clinic.shortName}` },
  description,
  applicationName: clinic.name,
  authors: [{ name: clinic.doctor.name }],
  creator: clinic.name,
  publisher: clinic.name,
  category: "health",
  keywords: [
    "orthopedic surgeon Visakhapatnam", "orthopedic doctor Vizag", "bone specialist Chinnamushidiwada",
    "fracture treatment Vizag", "joint replacement Visakhapatnam", "knee replacement Vizag",
    "sports injury clinic Vizag", "trauma care Visakhapatnam", "Dr Ramachandra orthopedic",
    "Ramachandra Ortho Care", "orthopedic clinic near me", "book orthopedic appointment Vizag",
  ],
  alternates: { canonical: "/" },
  openGraph: {
    type: "website", url: clinic.url, siteName: clinic.name, title, description, locale: "en_IN",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: `${clinic.name} — ${clinic.doctor.name}` }],
  },
  twitter: { card: "summary_large_image", title, description, images: ["/og.png"] },
  robots: { index: true, follow: true, googleBot: { index: true, follow: true, "max-image-preview": "large", "max-snippet": -1 } },
  formatDetection: { telephone: true },
  verification: { other: { "facebook-domain-verification": "ges6fj8n9tf73wtfqv5ql30d0fmo1x" } },
};

export const viewport: Viewport = { themeColor: "#0c7a68" };

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const jsonLd = {
  "@context": "https://schema.org",
  "@type": "MedicalClinic",
  "@id": clinic.url,
  name: clinic.name,
  url: clinic.url,
  image: `${clinic.url}/doctor.jpg`,
  logo: `${clinic.url}/icon.svg`,
  priceRange: "₹₹",
  medicalSpecialty: "Orthopedic",
  currenciesAccepted: "INR",
  address: {
    "@type": "PostalAddress",
    streetAddress: `${clinic.location.line1}, ${clinic.location.line2}`,
    addressLocality: clinic.location.city,
    addressRegion: clinic.location.state,
    postalCode: clinic.location.pin,
    addressCountry: "IN",
  },
  areaServed: { "@type": "City", name: clinic.location.city },
  aggregateRating: {
    "@type": "AggregateRating",
    ratingValue: String(clinic.rating.score),
    reviewCount: String(clinic.rating.count),
    bestRating: "5",
  },
  openingHoursSpecification: Object.entries(weeklyHours).flatMap(([d, wins]) =>
    (wins as Window[]).map((w) => ({ "@type": "OpeningHoursSpecification", dayOfWeek: DAY_NAMES[+d], opens: w.start, closes: w.end }))
  ),
  physician: { "@type": "Physician", name: clinic.doctor.name, medicalSpecialty: "Orthopedic", image: `${clinic.url}/doctor.jpg` },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${geistSans.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        <meta property="fb:app_id" content="1089886523536290" />
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
        {children}
      </body>
    </html>
  );
}
