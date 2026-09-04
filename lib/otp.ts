// ─────────────────────────────────────────────────────────────────────────────
// One-time-password store, server-side, in-memory.
//
// Closes the hole in patient self-service: cancel / reschedule / pay all
// trust a bare phone number, and a phone number is not a secret — anyone who
// knows it (prescription, billing, a forwarded chat) is treated as the owner.
// Here the number must prove it first: a 6-digit code sent to the SIM via the
// already-wired WhatsApp template channel, verified once, then the phone stays
// unlocked (within the OTP window) for the caller's whole self-service session
// so a patient paying AND rescheduling doesn't fire a fresh code each tap.
//
// Deliberately small and boring. A Map, an expiry, an attempt cap. Stored
// codes are hashed so a stray log never leaks a usable code, the entry is
// destroyed on success or after 5 bad guesses, and issuance rate-limits per
// phone so the endpoint can't be abused to spam the template sender.
// ─────────────────────────────────────────────────────────────────────────────
import { createHash, randomInt } from "node:crypto";

const CODE_TTL_MS = 5 * 60 * 1000; // Meta template reuse rules: an OTP stays valid ~5 min
const MAX_ATTEMPTS = 5;
const ISSUE_WINDOW_MS = 10 * 60 * 1000;
const MAX_ISSUES = 4; // a patient needs one code per session, never a stream

type Otp = {
  hash: string; // sha256 of the code — a log of this object must not give away the code
  expiresAt: number;
  attempts: number;
};
type Issue = { at: number };

const store = new Map<string, Otp>();
const issues = new Map<string, Issue[]>();

const hash = (code: string) => createHash("sha256").update(code).digest("hex");

function purge(): void {
  const now = Date.now();
  for (const [phone, otp] of store) if (otp.expiresAt <= now) store.delete(phone);
  for (const [phone, list] of issues) {
    const alive = list.filter((i) => now - i.at < ISSUE_WINDOW_MS);
    if (alive.length) issues.set(phone, alive);
    else issues.delete(phone);
  }
}

// Issue a fresh code for a phone. Returns the plain code to send; the store
// keeps only its hash. No-ops (returns null) when the phone issued too many
// codes recently, or already holds a live code (a second send while the first
// stands would just give an attacker two guesses). Callers should only reach
// this once otpEnabled() is true.
export function requestOtp(phone: string): string | null {
  purge();
  if (store.has(phone)) return null;

  const past = issues.get(phone) ?? [];
  if (past.length >= MAX_ISSUES) return null;
  past.push({ at: Date.now() });
  issues.set(phone, past);

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  store.set(phone, { hash: hash(code), expiresAt: Date.now() + CODE_TTL_MS, attempts: 0 });
  purge();
  return code;
}

// Verify a phone's code. Single-use: success clears the entry (the phone IS
// verified-until-expiry via `otpVerified`, which outlives the code). A wrong
// guess burns an attempt; 5 wrong guesses clear the code so the patient must
// start a fresh one — guarantees a brute-forcer can't crawl the 6-digit space
// through this endpoint.
export function consumeOtp(phone: string, code: string): "ok" | "bad" | "none" {
  const otp = store.get(phone);
  if (!otp) return "none";
  if (otp.expiresAt <= Date.now()) {
    store.delete(phone);
    return "none";
  }
  if (otp.attempts >= MAX_ATTEMPTS) {
    store.delete(phone);
    return "none";
  }
  if (otp.hash === hash(code.trim())) {
    store.delete(phone); // code consumed; verification state stays, see below
    return "ok";
  }
  otp.attempts += 1;
  // Clear on the guess that crosses the cap so a patient can immediately
  // re-request — otherwise the spent entry lingers and blocks issuance until
  // its TTL expiry, which reads to the patient as "locked out".
  if (otp.attempts >= MAX_ATTEMPTS) store.delete(phone);
  return "bad";
}

// The gate the mutation routes actually check: did this phone prove it holds
// the SIM? Set by a successful consume, and rides the same TTL as the code —
// one proof covers the whole self-service session for that number.
const verified = new Map<string, number>();
export function otpVerified(phone: string): boolean {
  const until = verified.get(phone);
  if (!until) return false;
  if (until <= Date.now()) {
    verified.delete(phone);
    return false;
  }
  return true;
}
export function markVerified(phone: string): void {
  verified.set(phone, Date.now() + CODE_TTL_MS);
}

// OTP enforcement is feature-gated on the WhatsApp template being configured
// (META_TEMPLATE_OTP). Until the clinic gets that template approved in Meta,
// the old bare-phone-number ownership check stays — the gate must never brick
// a patient's cancel/reschedule/pay over a missing template. The moment the
// env var lands, the SIM-proof turns on for every mutation.
export const otpEnabled = () => Boolean(process.env.META_TEMPLATE_OTP);