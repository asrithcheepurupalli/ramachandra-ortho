// ─────────────────────────────────────────────────────────────────────────────
// Meta WhatsApp Cloud API — direct integration, no BSP middleman. Access to the
// API itself is free (usage-based billing only, no plan-tier gate like AiSensy's
// Free Forever). Two send paths:
//   - sendText: free-form text, only valid within the 24h customer-service
//     window (i.e. replying inside an active conversation the patient started).
//     Used by the WhatsApp webhook for bot replies.
//   - sendTemplate: Meta-approved template, required for any business-initiated
//     message outside that window (a website booking confirmation, a
//     staff-initiated cancellation notice). Never throws — a WhatsApp failure
//     must never break a booking.
// ─────────────────────────────────────────────────────────────────────────────
import { fmt } from "@/lib/schedule";
import type { Appt } from "@/lib/store";

const GRAPH_VERSION = "v21.0";

function normalizeIndianPhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return digits;
  if (digits.length === 13 && digits.startsWith("091")) return `91${digits.slice(3)}`;
  return null;
}

async function callGraphApi(payload: Record<string, unknown>) {
  const token = process.env.META_WHATSAPP_TOKEN;
  const phoneNumberId = process.env.META_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) return;

  try {
    const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ messaging_product: "whatsapp", ...payload }),
    });
    if (!res.ok) console.error("Meta WhatsApp send failed", res.status, await res.text().catch(() => ""));
  } catch (err) {
    console.error("Meta WhatsApp send error", err);
  }
}

// Free-form text reply, only valid inside an active (patient-initiated,
// <24h) conversation. Used by the webhook route for bot replies, and by the
// admin broadcast route for same-day queue notices — Meta rejects (not
// throws; callGraphApi logs and swallows) any recipient outside that window,
// so a broadcast simply reaches whoever has an open conversation.
export async function sendText(phone: string, body: string) {
  const to = normalizeIndianPhone(phone);
  if (!to) return;
  await callGraphApi({ to, type: "text", text: { body } });
}

async function sendTemplate(phone: string, templateName: string | undefined, params: string[]) {
  const to = normalizeIndianPhone(phone);
  if (!templateName || !to) return;

  await callGraphApi({
    to,
    type: "template",
    template: {
      name: templateName,
      language: { code: process.env.META_TEMPLATE_LANG || "en_US" },
      components: [{ type: "body", parameters: params.map((text) => ({ type: "text", text })) }],
    },
  });
}

function dateTimeLabel(appt: Pick<Appt, "date" | "time">): string {
  const d = new Date(`${appt.date}T00:00:00`);
  const day = d.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" });
  return `${day}, ${fmt(appt.time)}`;
}

// Fired after every successful booking that has a phone number.
export function sendBookingConfirmation(appt: Pick<Appt, "name" | "phone" | "date" | "time" | "token">) {
  return sendTemplate(appt.phone, process.env.META_TEMPLATE_CONFIRM, [
    appt.name,
    dateTimeLabel(appt),
    "Orthopedic Consultation",
    `Token #${appt.token}`,
  ]);
}

// Fired when staff cancels a booking from /admin.
export function sendBookingCancellation(appt: Pick<Appt, "name" | "phone" | "date" | "time" | "token">) {
  return sendTemplate(appt.phone, process.env.META_TEMPLATE_CANCEL, [
    appt.name,
    dateTimeLabel(appt),
    `Token #${appt.token}`,
  ]);
}
