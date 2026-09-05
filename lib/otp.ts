// ─────────────────────────────────────────────────────────────────────────────
// One-time-password store, server-side.
//
// Closes the hole in patient self-service: cancel / reschedule / pay all
// trust a bare phone number, and a phone number is not a secret — anyone who
// knows it (prescription, billing, a forwarded chat) is treated as the owner.
// Here the number must prove it first: a 6-digit code sent to the SIM via the
// already-wired WhatsApp template channel, verified once, then the phone stays
// unlocked (within the OTP window) for the caller's whole self-service session
// so a patient paying AND rescheduling doesn't fire a fresh code each tap.
//
// WHY SUPABASE: on Vercel every /api route is its own serverless node, so a
// module-level Map written by verify-otp is invisible to reschedule — the live
// gate failed exactly that way (`verify-otp result ok` followed by
// `otpVerified:false` in prod logs). So the store lives in one `otp_challenges`
// row per phone, readable from every route — the same reason the bot's
// conversation memory lives in the wa_sessions table. When Supabase isn't
// configured at all (zero-config mock dev, one process), the in-memory Maps
// below are a faithful fallback.
//
// Deliberately small and boring. Stored codes are hashed so a stray log never
// leaks a usable code, the code is destroyed on success or after 5 bad
// guesses, and issuance rate-limits per phone so the endpoint can't be abused
// to spam the template sender.
// ─────────────────────────────────────────────────────────────────────────────
import { createHash, randomInt } from "node:crypto";
import { hasSupabase, supabaseAdmin } from "@/lib/supabase";

// Matches the auth template's "Expires in 10 minutes" so the server never
// rejects a code the patient's WhatsApp message still shows as valid. Same
// window rides the verified flag, so one proof unlocks the session.
const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const ISSUE_WINDOW_MS = 10 * 60 * 1000;
const MAX_ISSUES = 4; // a patient needs one code per session, never a stream

const hash = (code: string) => createHash("sha256").update(code).digest("hex");

// ── In-memory store — Supabase-unconfigured fallback ─────────────────────────
type MemOtp = { hash: string; expiresAt: number; attempts: number };
type MemIssue = { at: number };
const memStore = new Map<string, MemOtp>();
const memIssues = new Map<string, MemIssue[]>();
const memVerified = new Map<string, number>();

function memPurge(): void {
  const now = Date.now();
  for (const [phone, otp] of memStore) if (otp.expiresAt <= now) memStore.delete(phone);
  for (const [phone, list] of memIssues) {
    const alive = list.filter((i) => now - i.at < ISSUE_WINDOW_MS);
    if (alive.length) memIssues.set(phone, alive);
    else memIssues.delete(phone);
  }
  for (const [phone, until] of memVerified) if (until <= now) memVerified.delete(phone);
}

function memRequestOtp(phone: string): string | null {
  memPurge();
  if (memStore.has(phone)) return null;
  const past = memIssues.get(phone) ?? [];
  if (past.length >= MAX_ISSUES) return null;
  past.push({ at: Date.now() });
  memIssues.set(phone, past);
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  memStore.set(phone, { hash: hash(code), expiresAt: Date.now() + CODE_TTL_MS, attempts: 0 });
  memPurge();
  return code;
}

function memConsumeOtp(phone: string, code: string): "ok" | "bad" | "none" {
  const otp = memStore.get(phone);
  if (!otp) return "none";
  if (otp.expiresAt <= Date.now()) {
    memStore.delete(phone);
    return "none";
  }
  if (otp.attempts >= MAX_ATTEMPTS) {
    memStore.delete(phone);
    return "none";
  }
  if (otp.hash === hash(code.trim())) {
    memStore.delete(phone); // code consumed; verification state stays, see below
    return "ok";
  }
  otp.attempts += 1;
  // Clear on the guess that crosses the cap so a patient can immediately
  // re-request — otherwise the spent entry lingers and blocks issuance until
  // its TTL expiry, which reads to the patient as "locked out".
  if (otp.attempts >= MAX_ATTEMPTS) memStore.delete(phone);
  return "bad";
}

function memMarkVerified(phone: string): void {
  memVerified.set(phone, Date.now() + CODE_TTL_MS);
}

function memOtpVerified(phone: string): boolean {
  memPurge();
  const until = memVerified.get(phone);
  return !!until && until > Date.now();
}

// ── Supabase store — one row per phone, readable across serverless functions ──
// Rows self-shrink to one per phone and old one never grows beyond that; an
// expired code_hash or verified_until is simply treated as absent.
async function dbRequestOtp(phone: string): Promise<string | null> {
  const now = Date.now();
  const db = supabaseAdmin();
  const { data } = await db.from("otp_challenges").select("*").eq("phone", phone).maybeSingle();

  // A live code already standing → block re-issue (a second send while the
  // first stands would just give an attacker two guesses).
  if (data?.code_hash && data.expires_at && new Date(data.expires_at).getTime() > now) return null;

  // Issue-window rate limit: count issues within the latest window, resetting
  // the window once it ages past ISSUE_WINDOW_MS (mirrors the in-memory purge).
  let issueCount = 0;
  let windowStart = now;
  if (data?.window_started_at) {
    const started = new Date(data.window_started_at).getTime();
    if (now - started < ISSUE_WINDOW_MS) {
      issueCount = data.issue_count ?? 0;
      windowStart = started;
    }
  }
  if (issueCount >= MAX_ISSUES) return null;

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await db.from("otp_challenges").upsert(
    {
      phone,
      code_hash: hash(code),
      expires_at: new Date(now + CODE_TTL_MS).toISOString(),
      attempts: 0,
      issue_count: issueCount + 1,
      window_started_at: new Date(windowStart).toISOString(),
    },
    { onConflict: "phone" }
  );
  return code;
}

async function dbConsumeOtp(phone: string, code: string): Promise<"ok" | "bad" | "none"> {
  const now = Date.now();
  const db = supabaseAdmin();
  const { data } = await db.from("otp_challenges").select("*").eq("phone", phone).maybeSingle();
  if (!data?.code_hash) return "none";
  if (data.expires_at && new Date(data.expires_at).getTime() <= now) {
    await db.from("otp_challenges").update({ code_hash: null }).eq("phone", phone);
    return "none";
  }
  if ((data.attempts ?? 0) >= MAX_ATTEMPTS) {
    await db.from("otp_challenges").update({ code_hash: null }).eq("phone", phone);
    return "none";
  }
  if (data.code_hash === hash(code.trim())) {
    // Single-use: burn the code so it can't be replayed; the verified flag set
    // by markVerified (below) is what outlives it.
    await db.from("otp_challenges").update({ code_hash: null }).eq("phone", phone);
    return "ok";
  }
  const attempts = (data.attempts ?? 0) + 1;
  if (attempts >= MAX_ATTEMPTS) {
    // Same as the in-memory path: clear the code so a fresh request is possible.
    await db.from("otp_challenges").update({ code_hash: null, attempts: 0 }).eq("phone", phone);
  } else {
    await db.from("otp_challenges").update({ attempts }).eq("phone", phone);
  }
  return "bad";
}

async function dbMarkVerified(phone: string): Promise<void> {
  // Upsert keeps any unstated columns (code_hash etc.) — only verified_until
  // is stamped here; for a phone with no row yet the defaults apply.
  await supabaseAdmin().from("otp_challenges").upsert(
    { phone, verified_until: new Date(Date.now() + CODE_TTL_MS).toISOString() },
    { onConflict: "phone" }
  );
}

async function dbOtpVerified(phone: string): Promise<boolean> {
  const { data } = await supabaseAdmin()
    .from("otp_challenges")
    .select("verified_until")
    .eq("phone", phone)
    .maybeSingle();
  const until = data?.verified_until;
  return !!until && new Date(until).getTime() > Date.now();
}

// ── Public API ──
// OTP enforcement is feature-gated on the WhatsApp template being configured
// (META_TEMPLATE_OTP). Until the clinic gets that template approved in Meta,
// the old bare-phone-number ownership check stays — the gate must never brick
// a patient's cancel/reschedule/pay over a missing template. The moment the
// env var lands, the SIM-proof turns on for every mutation.
export const otpEnabled = () => Boolean(process.env.META_TEMPLATE_OTP);

export async function requestOtp(phone: string): Promise<string | null> {
  return hasSupabase() ? dbRequestOtp(phone) : memRequestOtp(phone);
}

export async function consumeOtp(phone: string, code: string): Promise<"ok" | "bad" | "none"> {
  return hasSupabase() ? dbConsumeOtp(phone, code) : memConsumeOtp(phone, code);
}

export async function markVerified(phone: string): Promise<void> {
  return hasSupabase() ? dbMarkVerified(phone) : memMarkVerified(phone);
}

export async function otpVerified(phone: string): Promise<boolean> {
  return hasSupabase() ? dbOtpVerified(phone) : memOtpVerified(phone);
}