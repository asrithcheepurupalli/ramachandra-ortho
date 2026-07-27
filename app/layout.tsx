import type { Metadata } from "next";
import { Geist } from "next/font/google";
import "./globals.css";
import { clinic } from "@/clinic.config";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: `${clinic.name} · ${clinic.location.city}`,
  description: `${clinic.doctor.name}, ${clinic.doctor.title}. Check if the doctor is in today, book an appointment in seconds, or chat on WhatsApp. ${clinic.location.line2}, ${clinic.location.city}.`,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${geistSans.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
