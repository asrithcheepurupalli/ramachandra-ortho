// ─────────────────────────────────────────────────────────────────────────────
// Bug desk: the one place failures across the site + WhatsApp bot get recorded
// and escalated. Every catch block that used to swallow with console.error now
// asks the desk to remember it.
//
//   report(source, message)   - persisted + (for criticals) immediately emailed
//   reportError(source, err)  - same, message derived from the thrown value
//
// Each distinct source+message pair folds into ONE error_logs row via a
// fingerprint, with an accumulating `count` — so a crash-loop or a webhook
// storm is "887 occurrences of one bug" rather than 887 rows. Critical errors
// trigger a real-time email (throttled to once per fingerprint per hour, plus
// a global cap so an error storm can't become an email storm). Warnings queue
// for the 6-hourly digest cron instead.
//
// Non-negotiable: report() never throws and never blocks an error path it is
// called from. A broken bugdesk — DB down, Resend down, anything — must never
// take down a booking or a webhook ack. Every failure inside is swallowed.
// ─────────────────────────────────────────────────────────────────────────────
import "server-only";
import { createHash } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { isRateLimited } from "@/lib/rate-limit";
import { sendBugdeskEmail, type BugdeskEmailItem } from "@/lib/mailer";
import { sendText } from "@/lib/meta-whatsapp";

export type BugSeverity = "critical" | "warning";

export type BugReportInput = {
  source: string; // "payments/webhook", "bot", "cron/reminders" ...
  message: string; // short, human-readable
  severity?: BugSeverity; // default "warning"
  info?: Record<string, unknown>; // context: ids, amounts, phone, channels ...
};

// IST datetime string for the emails (short, e.g. "10 Sep, 14:05").
export const fmtLastSeen = (d: Date | string) =>
  new Date(d).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

const fingerprintOf = (source: string, message: string) =>
  createHash("sha256").update(`${source} ${message}`).digest("hex").slice(0, 24);

// Persists the report (inserting or bumping the fingerprint row) and returns
// the accumulated occurrence count. Never throws.
async function persist(
  input: BugReportInput & { fingerprint: string; now: string }
): Promise<number> {
  const { fingerprint, source, message, severity, info, now } = input;
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return 1;

  try {
    const db = supabaseAdmin();
    const { data: row, error: readErr } = await db
      .from("error_logs")
      .select("count, info")
      .eq("fingerprint", fingerprint)
      .maybeSingle();
    if (readErr) throw readErr;

    if (row) {
      const nextCount = (row.count ?? 1) + 1;
      await db
        .from("error_logs")
        .update({
          count: nextCount,
          last_seen: now,
          info: info ?? row.info ?? null,
        })
        .eq("fingerprint", fingerprint);
      return nextCount;
    }

    const { error: insErr } = await db.from("error_logs").insert({
      fingerprint,
      source,
      message,
      severity,
      info: info ?? null,
      count: 1,
      first_seen: now,
      last_seen: now,
    });
    if (insErr) throw insErr;
    return 1;
  } catch (e) {
    console.error("bugdesk: persist failed", e);
    return 1;
  }
}

// WhatsApp copy for a critical alert. WhatsApp's own bold syntax (*x*) for the
// header, plain facts underneath, short enough to read on lock screen. No
// en dashes (the humanizer rule applies to this surface too).
const bugWhatsAppBody = (item: BugdeskEmailItem): string =>
  [
    "*Bug found: something needs a look*",
    "",
    `Source: ${item.source}`,
    `Issue: ${item.message}`,
    `Occurrences: ${item.count > 1 ? `${item.count} times` : "Once"}`,
    `Last seen: ${item.lastSeen}`,
  ].join("\n");

/** Full report. Never throws — callers can `await` it on an error path. */
export async function report(input: BugReportInput, err?: unknown): Promise<void> {
  const source = input.source;
  const message = input.message;
  const severity = input.severity ?? "warning";
  const info = input.info;

  // Dual-log so Vercel runtime logs stay the paper trail even if the DB is down.
  console.error(`bugdesk[${source}]`, message, err ?? "", info ?? {});

  // Not a bug desk environment (mock mode / no service role) — the console log
  // above is all we do.
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return;

  const fingerprint = fingerprintOf(source, message);
  const now = new Date().toISOString();
  const count = await persist({ source, message, severity, info, fingerprint, now });
  if (severity !== "critical") return;

  // Immediate alert — throttled. One per fingerprint per hour + a global cap.
  try {
    if (await isRateLimited(`bugdesk:alert:${fingerprint}`, 1, 60 * 60 * 1000)) return;
    if (await isRateLimited("bugdesk:alert:global", 15, 60 * 60 * 1000)) return;

    const item: BugdeskEmailItem = {
      source,
      message,
      severity,
      count,
      lastSeen: fmtLastSeen(now),
      info,
    };
    const ok = await sendBugdeskEmail({ kind: "alert", items: [item] });

    // Same alert, to the desk's phone: one WhatsApp line with a bolded header.
    // Shares the email's rate-limit budget so a storm pings once, not per beat.
    try {
      await sendText("+918317612636", bugWhatsAppBody(item));
    } catch (e) {
      console.error("bugdesk: whatsapp alert failed", e);
    }

    // Mark alerted (NOT digest_sent_at: a critical that keeps recurring should
    // also keep showing up in digests until someone resolves it — the count
    // accumulating on the row is the story).
    if (ok) {
      await supabaseAdmin()
        .from("error_logs")
        .update({ alerted_at: now })
        .eq("fingerprint", fingerprint);
    }
  } catch (e) {
    console.error("bugdesk: alert failed", e);
  }
}

/** Convenience: derive the message from a thrown value, then report. */
export async function reportError(
  source: string,
  err: unknown,
  opts?: { severity?: BugSeverity; info?: Record<string, unknown> }
): Promise<void> {
  const raw = err instanceof Error ? err.message : String(err ?? "unknown error");
  return report({ source, message: raw.slice(0, 500), severity: opts?.severity, info: opts?.info }, err);
}