// ─────────────────────────────────────────────────────────────────────────────
// Email via Resend API — raw fetch, same style as lib/razorpay.ts and
// lib/meta-whatsapp.ts. Never throws; all failures are logged and swallowed so
// a broken mailer never breaks a booking. Three composed senders:
// - sendNewAppointmentEmail: fired after payment confirms a new booking
// - sendRescheduledEmail: fired when an appointment is rescheduled
// - sendSessionDigestEmail: fired pre-session by the cron, listing today's appts
//
// One shared shell in the clinic's own brand. Typeface is Geist (the site's
// next/font), pulled from Google Fonts as a progressive enhancement: clients
// that fetch web fonts (Apple Mail, Outlook Mac, most Android) render Geist,
// everything else falls back to a clean system stack — the critical styling is
// always inline so Gmail never breaks the layout. The header carries the real
// deployed logo (/logo-mark.png, same mark the site header uses), a teal top
// bar, and a details card with a teal accent rail. No tracking pixels of any
// kind — it is the desk's own inbox. Copy is human, not "system".
// ─────────────────────────────────────────────────────────────────────────────
import { clinic } from "@/clinic.config";
import { fmt } from "@/lib/schedule";
import type { Appt, Source } from "@/lib/store";

const RESEND_API = "https://api.resend.com/emails";

// ── Brand tokens (mirror of app/globals.css so the email feels like the site)
const BRAND = {
  accent: "#0c7a68",
  accentDark: "#0a5d50",
  tint: "#e2f1ec",
  ink: "#0e1a17",
  muted: "#5c6b66",
  bone: "#f5f8f6",
  line: "#e3ebe7",
  soft: "#f7faf8",
  coral: "#bd3a23",
  coralTint: "#fdeae4",
  ok: "#0a7a52",
} as const;

// Geist first (when the client loads it), then the exact fallback stack the
// site uses. -apple-system/BlinkMacSystemFont give the sharpest look on Apple.
const FONT = `'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', ui-sans-serif, system-ui, sans-serif`;

const SRC_LABEL: Record<Source, string> = {
  website: "Website",
  whatsapp: "WhatsApp",
  walkin: "Walk-in",
};

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));

// "+91 93814 39203" for both "+919381439203" and bare "9381439203".
const humanPhone = (p: string) => {
  const digits = p.replace(/\D/g, "");
  const m = digits.match(/^(?:91)?(\d{10})$/);
  return m ? `+91 ${m[1].slice(0, 5)} ${m[1].slice(5)}` : p;
};

const longDate = (date: string, withWeekday = true) =>
  new Date(`${date}T00:00:00`).toLocaleDateString("en-IN", {
    ...(withWeekday ? { weekday: "long" as const } : {}),
    day: "numeric",
    month: "long",
    year: "numeric",
  });

async function sendEmail({
  to,
  subject,
  html,
  attachments,
}: {
  to: string | string[];
  subject: string;
  html: string;
  attachments?: { filename: string; content: string }[];
}): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.RESEND_FROM_EMAIL || "onboarding@resend.dev";

  if (!apiKey) {
    console.error("Email send skipped: RESEND_API_KEY not set");
    return false;
  }

  try {
    const res = await fetch(RESEND_API, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ from: fromEmail, to, subject, html, ...(attachments?.length ? { attachments } : {}) }),
    });

    if (!res.ok) {
      console.error("Email send failed", res.status, await res.text().catch(() => ""));
      return false;
    }
    return true;
  } catch (err) {
    console.error("Email send error", err);
    return false;
  }
}

// ── Template pieces ──────────────────────────────────────────────────────────

const chip = (text: string, fg: string, bg: string) =>
  `<span style="display:inline-block;padding:4px 11px 3px;border-radius:999px;font-family:${FONT};font-size:10px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;background-color:${bg};color:${fg};">${text}</span>`;

// A details row: muted caps label left, weighted value right. Rows sit in the
// soft details card and read cleanly stacked on a phone. `accent` lifts the
// value to teal so something like the fee or the new slot stands out.
const detailRow = (label: string, value: string, opts?: { accent?: boolean }) =>
  `<tr>
    <td style="width:40%;padding:12px 4px 12px 16px;vertical-align:top;font-family:${FONT};font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:${BRAND.muted};">${label}</td>
    <td style="padding:12px 16px 12px 8px;vertical-align:top;text-align:right;font-family:${FONT};font-size:${opts?.accent ? "16px" : "14px"};font-weight:600;letter-spacing:-0.01em;color:${opts?.accent ? BRAND.accentDark : BRAND.ink};">${value}</td>
  </tr>`;

// The soft details card with a teal rail down the left edge.
const detailsCard = (rows: string) =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:22px 0 0;">
    <tr>
      <td width="3" bgcolor="${BRAND.accent}" style="background-color:${BRAND.accent};border-radius:14px 0 0 14px;font-size:0;line-height:0;">&nbsp;</td>
      <td style="border:1px solid ${BRAND.line};border-left:none;border-radius:0 14px 14px 0;background-color:${BRAND.soft};">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>
      </td>
    </tr>
  </table>`;

// ── Shared chrome ────────────────────────────────────────────────────────────

function shell(opts: {
  chipText: string;
  chipFg: string;
  chipBg: string;
  headline: string;
  sub: string;
  body: string;
  preheader: string;
}): string {
  const { chipText, chipFg, chipBg, headline, sub, body, preheader } = opts;
  const tagline = `"ORTHOPEDIC CARE" · ${clinic.location.city.toUpperCase()}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light dark">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="x-apple-disable-message-reformatting">
<title>${esc(headline)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400..700&display=swap" rel="stylesheet">
<style>
  /* Geist loads for clients that fetch web fonts; inline styles guarantee the
     layut everywhere else. Dark mode for Apple Mail + Gmail's auto-dark. */
  @media (prefers-color-scheme: dark) {
    .e-bg { background-color: #0d1612 !important; }
    .e-card { background-color: #111b17 !important; border-color:#26352e !important; }
    .e-ink { color: #e9f0ec !important; }
    .e-muted { color: #9db2a9 !important; }
    .e-soft { background-color:#16251f !important; border-color:#26352e !important; }
    .e-line { border-color: #26352e !important; }
  }
  [data-ogsc] .e-bg { background-color: #0d1612 !important; }
  [data-ogsc] .e-card { border-color: #26352e !important; }
  [data-ogsc] .e-ink { color: #e9f0ec !important; }
  [data-ogsc] .e-muted { color: #9db2a9 !important; }
  [data-ogsc] .e-soft { background-color:#16251f !important; }
  @media (max-width: 620px) {
    .e-mobile { padding-left: 18px !important; padding-right: 18px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;-webkit-text-size-adjust:100%;word-spacing:normal;">
  <div class="e-bg" style="background-color:${BRAND.bone};">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 12px;">
      <div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;color:${BRAND.bone};">${esc(preheader)}</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="e-card" style="width:100%;max-width:600px;background-color:#ffffff;border:1px solid ${BRAND.line};border-radius:18px;overflow:hidden;">
        <tr><td height="4" bgcolor="${BRAND.accent}" style="background-color:${BRAND.accent};font-size:0;line-height:0;">&nbsp;</td></tr>
        <tr>
          <td class="e-mobile" style="padding:26px 32px 22px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td width="52" style="padding-right:14px;vertical-align:middle;">
                  <img src="${esc(clinic.url)}/logo-mark.png" alt="" width="52" height="41" style="display:block;width:52px;height:41px;border:0;outline:none;text-decoration:none;">
                </td>
                <td style="vertical-align:middle;">
                  <div class="e-ink" style="font-family:${FONT};font-size:16px;font-weight:600;letter-spacing:-0.015em;line-height:1.1;color:${BRAND.ink};">${esc(clinic.shortName)}</div>
                  <div class="e-muted" style="font-family:${FONT};font-size:9.5px;font-weight:600;letter-spacing:.13em;text-transform:uppercase;color:${BRAND.muted};margin-top:3px;">${esc(tagline)}</div>
                </td>
                <td align="right" style="vertical-align:middle;">${chip(chipText, chipFg, chipBg)}</td>
              </tr>
            </table>
          </td>
        </tr>
        <tr><td class="e-line" height="1" style="height:1px;background-color:${BRAND.line};font-size:0;">&nbsp;</td></tr>
        <tr>
          <td class="e-mobile" style="padding:30px 32px 8px;">
            <h1 style="margin:0;font-family:${FONT};font-size:23px;font-weight:600;letter-spacing:-0.02em;line-height:1.22;color:${BRAND.ink};">${headline}</h1>
            <p class="e-muted" style="margin:10px 0 0;font-family:${FONT};font-size:14px;line-height:1.55;color:${BRAND.muted};">${sub}</p>
          </td>
        </tr>
        <tr>
          <td class="e-mobile" style="padding:2px 32px 30px;">${body}</td>
        </tr>
        <tr><td class="e-line" height="1" style="height:1px;background-color:${BRAND.line};font-size:0;">&nbsp;</td></tr>
        <tr>
          <td class="e-mobile" style="padding:22px 32px 26px;background-color:${BRAND.soft};">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="vertical-align:top;">
                  <div class="e-ink" style="font-family:${FONT};font-size:13px;font-weight:600;letter-spacing:-0.01em;color:${BRAND.ink};">${esc(clinic.shortName)}</div>
                  <div class="e-muted" style="font-family:${FONT};font-size:12px;line-height:1.6;color:${BRAND.muted};margin-top:3px;">${esc(clinic.location.line1)}, ${esc(clinic.location.line2)}<br>${esc(clinic.location.city)}, ${esc(clinic.location.state)} ${esc(clinic.location.pin)}</div>
                </td>
                <td width="18"></td>
                <td style="vertical-align:top;text-align:right;">
                  <div style="display:inline-block;font-family:${FONT};font-size:10px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:${BRAND.muted};margin-top:1px;">Emergency</div>
                  <div style="font-family:${FONT};font-size:13px;font-weight:600;letter-spacing:0.01em;color:${BRAND.accentDark};margin-top:3px;">${esc(humanPhone(clinic.contact.emergency))}</div>
                </td>
              </tr>
              <tr><td colspan="3" height="14" style="font-size:0;">&nbsp;</td></tr>
              <tr>
                <td colspan="3" class="e-muted" style="font-family:${FONT};font-size:11px;line-height:1.6;color:${BRAND.muted};border-top:1px solid ${BRAND.line};padding-top:12px;">This is an automatic notice from the clinic booking system. ${esc(clinic.shortName)} never tracks who opens its mail.</td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </td></tr></table>
  </div>
</body>
</html>`;
}

// ── Sender: bug desk ─────────────────────────────────────────────────────────

// One item per issue in an alert or digest email. `lastSeen` is pre-formatted
// (bugdesk.ts formats the IST datetime) so this module stays type-focused.
export type BugdeskEmailItem = {
  source: string;
  message: string;
  severity: "critical" | "warning";
  count: number;
  lastSeen: string;
  info?: Record<string, unknown> | null;
  // The formatted thrown failure behind `message`, so an alert shows the
  // actual reason ("Failure retrieving data from server (code 42501)") rather
  // than only the caller's one-line summary.
  detail?: string;
};

// Monospace block that shows the raw failure behind an issue. Pre wrapped so
// the stack/no indentation survives; pre-wrap so long lines never overflow.
const bugBlock = (item: BugdeskEmailItem) => {
  const detail = item.detail ? `\n\n${esc("Reason: " + item.detail)}` : "";
  const info = item.info && Object.keys(item.info).length ? `\n\n${JSON.stringify(item.info, null, 2)}` : "";
  return `<pre style="margin:10px 0 0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:1.6;color:${BRAND.muted};background-color:${BRAND.bone};border:1px solid ${BRAND.line};border-radius:10px;padding:12px 14px;white-space:pre-wrap;word-break:break-word;">${esc(item.message)}${detail}${info}</pre>`;
};

function bugItemCard(item: BugdeskEmailItem): string {
  return `${detailsCard(`
      ${detailRow("Source", esc(item.source))}
      ${detailRow("Severity", esc(item.severity), { accent: item.severity === "critical" })}
      ${detailRow("Occurrences", item.count > 1 ? `${esc(item.count)} times` : "Once")}
      ${detailRow("Last seen", esc(item.lastSeen))}
    `)}
    ${bugBlock(item)}`;
}

export async function sendBugdeskEmail(opts: {
  kind: "alert" | "digest";
  items: BugdeskEmailItem[];
}): Promise<boolean> {
  const adminEmail = clinic.contact.adminEmail;
  const devEmail = "asrithcheepurupalli@made-by-ac.com";
  if (!adminEmail || !opts.items.length) return false;

  const isAlert = opts.kind === "alert";
  const head = opts.items[0];

  // One issue for an alert; a short stack for a digest.
  const body = isAlert
    ? bugItemCard(head)
    : opts.items.map(bugItemCard).join(`<div style="height:22px;font-size:0;">&nbsp;</div>`);

  const countLabel = opts.items.length === 1 ? "1 issue" : `${opts.items.length} issues`;

  return sendEmail({
    to: [adminEmail, devEmail],
    subject: isAlert
      ? `Bug alert: ${head.source} · ${head.message}`.slice(0, 120)
      : `Bug desk digest · ${countLabel}`,
    html: shell({
      chipText: isAlert ? "System alert" : "Bug desk",
      chipFg: isAlert ? BRAND.coral : BRAND.accentDark,
      chipBg: isAlert ? BRAND.coralTint : BRAND.tint,
      headline: isAlert ? "Something needs a look right now" : "Issues since the last check",
      sub: isAlert
        ? "A critical error just happened. Root cause and context below."
        : `${opts.items.length} issue${opts.items.length === 1 ? "" : "s"} logged since the last digest.`,
      body,
      preheader: `${isAlert ? "Critical:" : ""} ${head.message}`,
    }),
  });
}

// ── Sender: DB backup ────────────────────────────────────────────────────────

// Daily cron dump of patients + appointments as a JSON attachment. Only goes
// to the clinic's own inbox — unlike the bug desk mail, this carries real
// patient PII (names, phones, ages), so it shouldn't also cc the developer.
export async function sendBackupEmail(json: string, dateLabel: string): Promise<boolean> {
  const adminEmail = clinic.contact.adminEmail;
  if (!adminEmail) return false;

  const sizeKb = (json.length / 1024).toFixed(1);
  const filename = `ortho-backup-${dateLabel}.json`;

  return sendEmail({
    to: adminEmail,
    subject: `Daily backup · ${dateLabel}`,
    html: shell({
      chipText: "Backup",
      chipFg: BRAND.accentDark,
      chipBg: BRAND.tint,
      headline: "Today's data backup",
      sub: "A full export of patients and appointments is attached as a JSON file. Keep it somewhere safe.",
      body: detailsCard(`
        ${detailRow("File", esc(filename))}
        ${detailRow("Size", `${esc(sizeKb)} KB`)}
      `),
      preheader: `Daily backup attached · ${filename}`,
    }),
    attachments: [{ filename, content: Buffer.from(json, "utf8").toString("base64") }],
  });
}

// ── Sender: new appointment ──────────────────────────────────────────────────

export async function sendNewAppointmentEmail(
  appt: Pick<Appt, "token" | "name" | "phone" | "date" | "time" | "fee" | "source" | "patientCode">
): Promise<boolean> {
  const adminEmail = clinic.contact.adminEmail;
  if (!adminEmail) return false;

  const dateLabel = longDate(appt.date);
  const srcTitle = SRC_LABEL[appt.source] ?? appt.source;

  const body = `
    ${detailsCard(`
      ${detailRow("Patient", esc(appt.name))}
      ${detailRow("Phone", humanPhone(esc(appt.phone)))}
      ${detailRow("Code", appt.patientCode ? `#${esc(appt.patientCode)}` : "New patient")}
      ${detailRow("Date", esc(dateLabel))}
      ${detailRow("Time", esc(fmt(appt.time)))}
      ${detailRow("Via", esc(srcTitle))}
      ${detailRow("Fee", `${esc(clinic.currency)}${esc(appt.fee)}`, { accent: true })}
    `)}
    <p style="margin:18px 0 0;font-family:${FONT};font-size:12.5px;line-height:1.6;color:${BRAND.muted};">Payment is confirmed and the patient is on the live queue. Nothing else to do today.</p>`;

  return sendEmail({
    to: adminEmail,
    subject: `New appointment: ${appt.name} · #${appt.token}`,
    html: shell({
      chipText: "Confirmed",
      chipFg: BRAND.accentDark,
      chipBg: BRAND.tint,
      headline: `A new appointment for ${esc(appt.name)}`,
      sub: `Booked via ${esc(srcTitle.toLowerCase())}, and the payment came through in full.`,
      body,
      preheader: `${appt.name} · ${dateLabel} · ${fmt(appt.time)}`,
    }),
  });
}

// ── Sender: reschedule ───────────────────────────────────────────────────────

export async function sendRescheduledEmail(
  appt: Pick<Appt, "token" | "name" | "date" | "time">
): Promise<boolean> {
  const adminEmail = clinic.contact.adminEmail;
  if (!adminEmail) return false;

  const dateLabel = longDate(appt.date);

  const body = `
    ${detailsCard(`
      ${detailRow("Patient", esc(appt.name))}
      ${detailRow("Booking code", `#${esc(appt.token)}`)}
      ${detailRow("Now on", esc(dateLabel), { accent: true })}
      ${detailRow("New time", esc(fmt(appt.time)), { accent: true })}
    `)}
    <p style="margin:18px 0 0;font-family:${FONT};font-size:12.5px;line-height:1.6;color:${BRAND.muted};">The queue and the patient reminder both use these new times. No action needed unless the patient calls in about a conflict.</p>`;

  return sendEmail({
    to: adminEmail,
    subject: `Rescheduled: ${appt.name} · #${appt.token}`,
    html: shell({
      chipText: "Rescheduled",
      chipFg: BRAND.coral,
      chipBg: BRAND.coralTint,
      headline: `${esc(appt.name)} has moved to a new slot`,
      sub: "The times on the right are the updated date and time.",
      body,
      preheader: `${appt.name} · moved to ${dateLabel}, ${fmt(appt.time)}`,
    }),
  });
}

// ── Sender: session digest ───────────────────────────────────────────────────

export async function sendSessionDigestEmail(
  label: string,
  date: string,
  appts: Pick<Appt, "token" | "time" | "name" | "phone" | "fee" | "paid">[]
): Promise<boolean> {
  const adminEmail = clinic.contact.adminEmail;
  if (!adminEmail || !appts.length) return false;

  const dateLabel = longDate(date, false);
  const paidCount = appts.filter((a) => a.paid).length;
  const total = appts.reduce((sum, a) => sum + (a.fee || 0), 0);

  const rows = appts
    .map(
      (a) => `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:10px;">
        <tr>
          <td width="64" style="padding:13px 12px 13px 16px;vertical-align:middle;border:1px solid ${BRAND.line};border-right:none;background-color:${a.paid ? BRAND.tint : BRAND.soft};border-radius:14px 0 0 14px;">
            <div style="font-family:${FONT};font-size:15px;font-weight:600;letter-spacing:-0.01em;color:${a.paid ? BRAND.accentDark : BRAND.ink};line-height:1.1;">${esc(fmt(a.time))}</div>
            <div style="font-family:${FONT};font-size:10px;font-weight:600;color:${BRAND.muted};margin-top:2px;">#${esc(a.token)}</div>
          </td>
          <td style="padding:13px 14px;vertical-align:middle;border:1px solid ${BRAND.line};border-left:none;background-color:#ffffff;border-radius:0 14px 14px 0;">
            <div class="e-ink" style="font-family:${FONT};font-size:14px;font-weight:600;letter-spacing:-0.01em;color:${BRAND.ink};line-height:1.25;">${esc(a.name)}</div>
            <div class="e-muted" style="font-family:${FONT};font-size:12px;color:${BRAND.muted};margin-top:2px;">${humanPhone(esc(a.phone))}</div>
          </td>
          <td style="padding:13px 16px 13px 10px;vertical-align:middle;text-align:right;white-space:nowrap;">
            ${a.paid ? chip("Paid", BRAND.ok, BRAND.tint) : chip("Unpaid", BRAND.muted, "#edf1ef")}
          </td>
        </tr>
      </table>`
    )
    .join("");

  const body = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:26px 0 0;background-color:${BRAND.tint};border-radius:14px;">
      <tr>
        <td style="padding:14px 18px;font-family:${FONT};font-size:12px;font-weight:600;letter-spacing:.04em;color:${BRAND.accentDark};">${esc(appts.length)} booking${appts.length === 1 ? "" : "s"} for the ${esc(label.toLowerCase())} session</td>
        <td align="right" style="padding:14px 18px;font-family:${FONT};font-size:12px;font-weight:600;color:${BRAND.accentDark};">${esc(clinic.currency)}${esc(total)} · ${esc(paidCount)} paid</td>
      </tr>
    </table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:14px;">${rows}</table>
    <p style="margin:16px 0 0;font-family:${FONT};font-size:12.5px;line-height:1.6;color:${BRAND.muted};">Unpaid entries were settled in cash at the desk. Sent 45 minutes before the session starts.</p>`;

  return sendEmail({
    to: adminEmail,
    subject: `${label} session · ${dateLabel} · ${appts.length} booking${appts.length === 1 ? "" : "s"}`,
    html: shell({
      chipText: `${label} session`,
      chipFg: BRAND.accentDark,
      chipBg: BRAND.tint,
      headline: `Who is coming in this ${label.toLowerCase()} session`,
      sub: `${dateLabel} · what the desk should expect in the next bit.`,
      body,
      preheader: `${appts.length} bookings for ${dateLabel}`,
    }),
  });
}