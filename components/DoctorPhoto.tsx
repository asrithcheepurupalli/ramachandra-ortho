"use client";

import { useState } from "react";
import { clinic } from "@/clinic.config";

// Shows Dr. Ramachandra's photo (public/doctor.jpg). Falls back to a clean
// monogram if the file isn't present yet, so the UI never breaks.
export function DoctorPhoto({ className = "", monogramText = "MR" }: { className?: string; monogramText?: string }) {
  const [ok, setOk] = useState(true);
  if (ok) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src="/doctor.jpg"
        alt={`${clinic.doctor.name}, ${clinic.doctor.title} at ${clinic.name}`}
        onError={() => setOk(false)}
        className={`object-cover object-top ${className}`}
      />
    );
  }
  return <div className={`grid place-items-center bg-brand font-bold text-white ${className}`}>{monogramText}</div>;
}
