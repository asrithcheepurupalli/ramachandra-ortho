import type { Metadata, Viewport } from "next";
import { Geist } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";
import { clinic } from "@/clinic.config";
import { weeklyHours, type Window } from "@/lib/schedule";

// Startup check: catch a missing OTP template before patients notice.
if (process.env.NODE_ENV === "production" && !process.env.META_TEMPLATE_OTP) {
  console.error("META_TEMPLATE_OTP is not set -- patient self-service (cancel/reschedule/pay) has no OTP gate");
}

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
    "Ramachandra Ortho Care", "Ramachandra Ortho Care and Clinics", "orthopedic clinic near me", "book orthopedic appointment Vizag",
  ],
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    url: clinic.url,
    siteName: clinic.name,
    title,
    description,
    locale: "en_IN",
    images: [
      { url: "/clinic-reception.jpg", width: 1200, height: 800, alt: `${clinic.name} — Clinic Reception & Facility` },
      { url: "/doctor.jpg", width: 800, height: 800, alt: `${clinic.doctor.name} — Orthopedic Surgeon` },
      { url: "/og.png", width: 1200, height: 630, alt: `${clinic.name} — ${clinic.doctor.name}` },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: ["/clinic-reception.jpg", "/doctor.jpg", "/og.png"],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
  },
  formatDetection: { telephone: true, address: true, email: true },
  other: {
    "thumbnail": `${clinic.url}/clinic-reception.jpg`,
    "image": `${clinic.url}/clinic-reception.jpg`,
    "facebook-domain-verification": "ges6fj8n9tf73wtfqv5ql30d0fmo1x",
  },
  appleWebApp: { capable: true, title: clinic.shortName, statusBarStyle: "black-translucent" },
  icons: {
    icon: [
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icon.png", sizes: "512x512", type: "image/png" }],
  },
};

export const viewport: Viewport = {
  themeColor: "#0c7a68",
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
};

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": ["MedicalClinic", "LocalBusiness", "MedicalBusiness"],
      "@id": `${clinic.url}/#clinic`,
      name: clinic.name,
      alternateName: [
        clinic.shortName,
        "Ramachandra Ortho Care and Clinics",
        "Dr. Ramachandra Orthopedic Clinic",
      ],
      url: clinic.url,
      logo: {
        "@type": "ImageObject",
        url: `${clinic.url}/icon.png`,
        width: 512,
        height: 512,
      },
      image: [
        `${clinic.url}/clinic-reception.jpg`,
        `${clinic.url}/doctor.jpg`,
        `${clinic.url}/og.png`,
        `${clinic.url}/icon.png`,
      ],
      telephone: clinic.contact.phone,
      email: clinic.contact.email,
      priceRange: "₹₹",
      currenciesAccepted: "INR",
      paymentAccepted: "Cash, UPI, Credit Card, Debit Card, Online Payment",
      medicalSpecialty: [
        "Orthopedic",
        "JointReplacement",
        "TraumaCare",
        "SportsMedicine",
        "PediatricOrthopedics",
        "Rheumatology",
      ],
      address: {
        "@type": "PostalAddress",
        streetAddress: `${clinic.location.line1}, ${clinic.location.line2}`,
        addressLocality: clinic.location.city,
        addressRegion: clinic.location.state,
        postalCode: clinic.location.pin,
        addressCountry: "IN",
      },
      hasMap: clinic.location.mapsUrl,
      areaServed: {
        "@type": "City",
        name: clinic.location.city,
      },
      aggregateRating: {
        "@type": "AggregateRating",
        ratingValue: String(clinic.rating.score),
        reviewCount: String(clinic.rating.count),
        bestRating: "5",
        worstRating: "1",
      },
      openingHoursSpecification: Object.entries(weeklyHours).flatMap(([d, wins]) =>
        (wins as Window[]).map((w) => ({
          "@type": "OpeningHoursSpecification",
          dayOfWeek: DAY_NAMES[+d],
          opens: w.start,
          closes: w.end,
        }))
      ),
      physician: {
        "@type": "Physician",
        name: clinic.doctor.name,
        jobTitle: clinic.doctor.title,
        medicalSpecialty: "Orthopedic",
        image: `${clinic.url}/doctor.jpg`,
        description: clinic.doctor.experienceNote,
      },
      potentialAction: [
        {
          "@type": "ReserveAction",
          target: {
            "@type": "EntryPoint",
            urlTemplate: `${clinic.url}/book`,
            inLanguage: ["en", "te", "hi"],
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
      ],
    },
    {
      "@type": "WebSite",
      "@id": `${clinic.url}/#website`,
      url: clinic.url,
      name: clinic.name,
      description,
      publisher: { "@id": `${clinic.url}/#clinic` },
      inLanguage: ["en-IN", "te-IN", "hi-IN"],
    },
    {
      "@type": "SiteNavigationElement",
      "@id": `${clinic.url}/#navigation`,
      name: [
        "Book Appointment",
        "My Appointment",
        "Orthopedic Services",
        "Clinic Location & Hours",
        "Patient Reviews",
      ],
      url: [
        `${clinic.url}/book`,
        `${clinic.url}/my-appointment`,
        `${clinic.url}#services`,
        `${clinic.url}#location`,
        `${clinic.url}#reviews`,
      ],
    },
    {
      "@type": "FAQPage",
      "@id": `${clinic.url}/#faq`,
      mainEntity: [
        {
          "@type": "Question",
          name: "Do I need to register to book an appointment?",
          acceptedAnswer: {
            "@type": "Answer",
            text: "No. Just pick a slot, enter your name and phone number, and you get an instant token confirmation.",
          },
        },
        {
          "@type": "Question",
          name: "What are the orthopedic consultation fees?",
          acceptedAnswer: {
            "@type": "Answer",
            text: `New patients: ₹${clinic.consultationFee} (paid online when booking). Returning patients: ₹${clinic.returningFee} (paid at the clinic counter). Free review within 10 days of a prior consultation.`,
          },
        },
        {
          "@type": "Question",
          name: `Can I walk in to ${clinic.shortName} without an online appointment?`,
          acceptedAnswer: {
            "@type": "Answer",
            text: "Yes. Walk-ins are always welcome. Online booking reserves your token in advance so you avoid waiting in the reception queue.",
          },
        },
        {
          "@type": "Question",
          name: "What if I miss my appointment slot?",
          acceptedAnswer: {
            "@type": "Answer",
            text: "Message the clinic on WhatsApp or reschedule online via My Appointment, and your token will be adjusted to the next available slot.",
          },
        },
        {
          "@type": "Question",
          name: "How do I check, reschedule or pay for my appointment?",
          acceptedAnswer: {
            "@type": "Answer",
            text: "Visit the My Appointment page on our website or text on WhatsApp and enter your mobile number to view, reschedule or pay for your consultation.",
          },
        },
      ],
    },
  ],
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${geistSans.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        <meta property="fb:app_id" content="1089886523536290" />
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
        {children}
        <Analytics />
      </body>
    </html>
  );
}
