// ─────────────────────────────────────────────────────────────────────────────
// Email via Resend API — raw fetch, same style as lib/razorpay.ts and
// lib/meta-whatsapp.ts. Never throws; all failures are logged and swallowed so
// a broken mailer never breaks a booking. Three composed senders:
// - sendNewAppointmentEmail: fired after payment confirms a new booking
// - sendRescheduledEmail: fired when an appointment is rescheduled
// - sendSessionDigestEmail: fired pre-session by the cron, listing today's appts
// ─────────────────────────────────────────────────────────────────────────────
import { clinic } from "@/clinic.config";
import { fmt } from "@/lib/schedule";
import type { Appt } from "@/lib/store";

const RESEND_API = "https://api.resend.com/emails";

async function sendEmail({
  to,
  subject,
  html,
}: {
  to: string;
  subject: string;
  html: string;
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
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from: fromEmail,
        to,
        subject,
        html,
      }),
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

export async function sendNewAppointmentEmail(
  appt: Pick<Appt, "token" | "name" | "phone" | "date" | "time" | "fee" | "source" | "patientCode">
): Promise<boolean> {
  const adminEmail = clinic.contact.adminEmail;
  if (!adminEmail) return false;

  const dateTime = new Date(`${appt.date}T00:00:00`);
  const dateLabel = dateTime.toLocaleDateString("en-IN", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  const html = `
    <h2>New Appointment Confirmed</h2>
    <p><strong>${appt.name}</strong> · Token #${appt.token}</p>
    <table style="border-collapse: collapse; width: 100%; max-width: 500px; margin-top: 16px;">
      <tr style="border-bottom: 1px solid #e5e7eb;">
        <td style="padding: 8px 0; font-weight: 500;">Phone</td>
        <td style="padding: 8px 0; text-align: right;">${appt.phone}</td>
      </tr>
      <tr style="border-bottom: 1px solid #e5e7eb;">
        <td style="padding: 8px 0; font-weight: 500;">Patient Code</td>
        <td style="padding: 8px 0; text-align: right;">${appt.patientCode || "—"}</td>
      </tr>
      <tr style="border-bottom: 1px solid #e5e7eb;">
        <td style="padding: 8px 0; font-weight: 500;">Date</td>
        <td style="padding: 8px 0; text-align: right;">${dateLabel}</td>
      </tr>
      <tr style="border-bottom: 1px solid #e5e7eb;">
        <td style="padding: 8px 0; font-weight: 500;">Time</td>
        <td style="padding: 8px 0; text-align: right;">${fmt(appt.time)}</td>
      </tr>
      <tr style="border-bottom: 1px solid #e5e7eb;">
        <td style="padding: 8px 0; font-weight: 500;">Fee</td>
        <td style="padding: 8px 0; text-align: right;">${clinic.currency}${appt.fee}</td>
      </tr>
      <tr>
        <td style="padding: 8px 0; font-weight: 500;">Source</td>
        <td style="padding: 8px 0; text-align: right; text-transform: capitalize;">${appt.source}</td>
      </tr>
    </table>
  `;

  return sendEmail({
    to: adminEmail,
    subject: `New appointment: ${appt.name} · #${appt.token}`,
    html,
  });
}

export async function sendRescheduledEmail(
  appt: Pick<Appt, "token" | "name" | "date" | "time">
): Promise<boolean> {
  const adminEmail = clinic.contact.adminEmail;
  if (!adminEmail) return false;

  const dateTime = new Date(`${appt.date}T00:00:00`);
  const dateLabel = dateTime.toLocaleDateString("en-IN", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  const html = `
    <h2>Appointment Rescheduled</h2>
    <p><strong>${appt.name}</strong> · Token #${appt.token}</p>
    <table style="border-collapse: collapse; width: 100%; max-width: 500px; margin-top: 16px;">
      <tr style="border-bottom: 1px solid #e5e7eb;">
        <td style="padding: 8px 0; font-weight: 500;">New Date</td>
        <td style="padding: 8px 0; text-align: right;">${dateLabel}</td>
      </tr>
      <tr>
        <td style="padding: 8px 0; font-weight: 500;">New Time</td>
        <td style="padding: 8px 0; text-align: right;">${fmt(appt.time)}</td>
      </tr>
    </table>
  `;

  return sendEmail({
    to: adminEmail,
    subject: `Rescheduled: ${appt.name} · #${appt.token}`,
    html,
  });
}

export async function sendSessionDigestEmail(
  label: string,
  date: string,
  appts: Pick<Appt, "token" | "time" | "name" | "phone" | "fee" | "paid">[]
): Promise<boolean> {
  const adminEmail = clinic.contact.adminEmail;
  if (!adminEmail || !appts.length) return false;

  const dateTime = new Date(`${date}T00:00:00`);
  const dateLabel = dateTime.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  const rows = appts
    .map(
      (a) => `
    <tr style="border-bottom: 1px solid #e5e7eb;">
      <td style="padding: 8px; text-align: center;">#${a.token}</td>
      <td style="padding: 8px;">${fmt(a.time)}</td>
      <td style="padding: 8px;">${a.name}</td>
      <td style="padding: 8px; font-family: monospace;">${a.phone}</td>
      <td style="padding: 8px; text-align: right;">${clinic.currency}${a.fee}</td>
      <td style="padding: 8px; text-align: center;">${a.paid ? "✓" : "—"}</td>
    </tr>
  `
    )
    .join("");

  const html = `
    <h2>${label} Session · ${dateLabel}</h2>
    <p><strong>${appts.length}</strong> appointment(s)</p>
    <table style="border-collapse: collapse; width: 100%; margin-top: 16px; font-size: 14px;">
      <thead>
        <tr style="border-bottom: 2px solid #1f2937; background-color: #f3f4f6;">
          <th style="padding: 8px; text-align: center; font-weight: 600;">Token</th>
          <th style="padding: 8px; font-weight: 600;">Time</th>
          <th style="padding: 8px; font-weight: 600;">Name</th>
          <th style="padding: 8px; font-weight: 600;">Phone</th>
          <th style="padding: 8px; text-align: right; font-weight: 600;">Fee</th>
          <th style="padding: 8px; text-align: center; font-weight: 600;">Paid</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  `;

  return sendEmail({
    to: adminEmail,
    subject: `${label} session · ${dateLabel} · ${appts.length} appointment(s)`,
    html,
  });
}
