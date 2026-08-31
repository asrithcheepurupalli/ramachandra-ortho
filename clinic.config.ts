// ─────────────────────────────────────────────────────────────────────────────
// SINGLE SOURCE OF TRUTH for this clinic. Everything patient-facing reads from
// here, so re-skinning for the next clinic = editing this one file.
// (Fields marked EDIT are placeholders the clinic will confirm later.)
// ─────────────────────────────────────────────────────────────────────────────

export const clinic = {
  name: "Ramachandra Ortho Care & Clinics",
  shortName: "Ramachandra Ortho Care",
  tagline: "Bones, joints and mobility, in careful hands.",
  url: "https://ramachandracare.vercel.app", // EDIT: point to the clinic's own domain later
  doctor: {
    name: "Dr. M. Ramachandra",
    // EDIT: exact qualifications to be confirmed by the clinic.
    title: "Orthopedic Surgeon & Trauma Care Specialist",
    experienceNote: "10 years of experience in joint replacements, fractures and sports injuries",
  },
  rating: { score: 4.8, count: 123, source: "Google" },

  // EDIT later: real fee. Kept editable in admin.
  consultationFee: 499,
  currency: "₹",

  contact: {
    whatsapp: "+919381439203",
    phone: "+919381439203",
    landline: "+918913541573",
    emergency: "+919441156566", // emergency-only, label it as such wherever shown
    email: "care@ramachandraortho.in",
  },

  location: {
    line1: "7-181/1/1, Ground Floor, Phanidhar Plaza",
    line2: "Main Road, Chinnamushidiwada",
    city: "Visakhapatnam",
    state: "Andhra Pradesh",
    pin: "530051",
    mapsUrl:
      "https://www.google.com/maps/search/?api=1&query=Ramachandra+Ortho+Care+Chinnamushidiwada",
  },

  // Booking slot length in minutes (tokens are issued per slot).
  slotMinutes: 10,

  languages: ["en", "te", "hi"] as const,
} as const;

export type Lang = (typeof clinic.languages)[number];
