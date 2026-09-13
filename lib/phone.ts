// Canonical form for patient contact numbers. Every booking write and every
// patient lookup funnels through this, so a number typed as "98409 12345",
// "+91 98409 12345", or sent by WhatsApp as Meta's sender id "919840912345"
// all mean the same person. Keep it dependency-free: it's imported by server
// routes (lib/db.ts) and client-bundled modules (lib/store.ts, lib/admin-db.ts).
export function normalizePhone(raw: string): string {
  const digits = (raw ?? "").replace(/\D/g, "");
  // WhatsApp Cloud API sender ids carry the 91 country code; trim it to the
  // 10 local digits every other surface (booking form, admin, lookup) uses.
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  // Some landline habits prefix a 0 (011...); a bare 0-start country code.
  if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
  if (digits.length > 10) return digits.slice(-10);
  return digits;
}

// True for a 10-digit number that's actually a valid Indian mobile (leading
// digit 6-9) rather than just any 10 digits typed into the field.
export function isValidIndianMobile(normalized: string): boolean {
  return normalized.length === 10 && /^[6-9]/.test(normalized);
}

// The shapes a stored phone might take for the same person. Lookups that go to
// the DB match all of them (`.in(...)`), so pre-normalization rows written
// with a country prefix still surface for a patient typing their local number.
// Canonical-first so the common case (already-normalized) hits first.
export function phoneMatchVariants(raw: string): string[] {
  const local = normalizePhone(raw);
  if (!local) return [""];
  return Array.from(new Set([local, `91${local}`, `+91${local}`, `0${local}`]));
}