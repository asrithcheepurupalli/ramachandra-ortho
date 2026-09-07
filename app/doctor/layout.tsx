import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Doctor",
  robots: { index: false, follow: false, nocache: true },
};

export default function DoctorLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
