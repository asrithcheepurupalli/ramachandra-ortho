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
import { createHmac, timingSafeEqual } from "node:crypto";
import { fmt } from "@/lib/schedule";
import type { Appt } from "@/lib/store";

const GRAPH_VERSION = "v21.0";

// Shared by the webhook route and the Flow endpoint. The WABA is subscribed
// to two Meta apps: chat messages arrive signed by one, the Flow endpoint's
// health-check pings by the other. Both secrets are checked so either app
// can sign a given request (HMAC-SHA256 over the raw body).
export function verifySignature(rawBody: string, signatureHeader: string | null): boolean {
  const secrets = [process.env.META_APP_SECRET, process.env.META_APP_SECRET_ALT].filter(
    (s): s is string => !!s
  );
  if (!secrets.length || !signatureHeader) return false;

  const provided = signatureHeader.replace(/^sha256=/, "");
  const providedBuf = Buffer.from(provided, "hex");
  return secrets.some((secret) => {
    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
    const expectedBuf = Buffer.from(expected, "hex");
    if (expectedBuf.length !== providedBuf.length) return false;
    return timingSafeEqual(expectedBuf, providedBuf);
  });
}

// Constant-time string compare — used for the webhook verify-token handshake
// so it doesn't leak match-length via early-exit timing, same as verifySignature.
export function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

function normalizeIndianPhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return digits;
  if (digits.length === 13 && digits.startsWith("091")) return `91${digits.slice(3)}`;
  return null;
}

// Returns whether Meta actually accepted the message, so callers (the admin
// broadcast route in particular) can report real delivery counts instead of
// assuming success just because the HTTP call didn't throw.
async function callGraphApi(payload: Record<string, unknown>): Promise<boolean> {
  const token = process.env.META_WHATSAPP_TOKEN;
  const phoneNumberId = process.env.META_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) {
    console.error("Meta WhatsApp send skipped: META_WHATSAPP_TOKEN or META_PHONE_NUMBER_ID not set");
    return false;
  }

  try {
    const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ messaging_product: "whatsapp", ...payload }),
    });
    if (!res.ok) {
      console.error("Meta WhatsApp send failed", res.status, await res.text().catch(() => ""));
      return false;
    }
    return true;
  } catch (err) {
    console.error("Meta WhatsApp send error", err);
    return false;
  }
}

// Free-form text reply, only valid inside an active (patient-initiated,
// <24h) conversation. Used by the webhook route for bot replies, and by the
// admin broadcast route for same-day queue notices — Meta rejects any
// recipient outside that window, which callGraphApi now surfaces as a
// `false` return instead of swallowing, so a broadcast can report who it
// actually reached.
export async function sendText(phone: string, body: string): Promise<boolean> {
  const to = normalizeIndianPhone(phone);
  if (!to) return false;
  return callGraphApi({ to, type: "text", text: { body } });
}

// Reply buttons — up to 3 tappable options, title capped at 20 chars (Meta's
// hard limit). Used instead of sendText's numbered-list-as-plain-text for
// short option sets (e.g. picking a morning/evening window) so the patient
// taps instead of reading and typing a number.
export async function sendButtons(phone: string, body: string, options: string[]): Promise<boolean> {
  const to = normalizeIndianPhone(phone);
  if (!to || !options.length) return false;
  return callGraphApi({
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: body },
      action: {
        buttons: options.slice(0, 3).map((title) => ({
          type: "reply",
          reply: { id: title.slice(0, 200), title: title.slice(0, 20) },
        })),
      },
    },
  });
}

// List message — up to 10 rows (single section), title capped at 24 chars.
// Used for option sets too long for buttons (a week of day chips, a window's
// worth of time slots) so the patient still taps rather than reading a
// numbered wall of text and typing a digit back.
export async function sendList(phone: string, body: string, buttonLabel: string, options: string[]): Promise<boolean> {
  const to = normalizeIndianPhone(phone);
  if (!to || !options.length) return false;
  return callGraphApi({
    to,
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: body },
      action: {
        button: buttonLabel.slice(0, 20),
        sections: [
          { rows: options.slice(0, 10).map((title) => ({ id: title.slice(0, 200), title: title.slice(0, 24) })) },
        ],
      },
    },
  });
}

// Meta locks a language code from accepting NEW templates for ~4 weeks after a
// template in it is deleted, so a clinic that deletes an "en" template can no
// longer create more "en" ones until the cooldown passes. The workaround is to
// approve new templates under a different locale bucket (en_GB, te, hi ...).
// Each sender can then pass its own code via a per-template <TEMPLATE>_LANG
// env var, falling back to the global META_TEMPLATE_LANG so nothing changes
// for templates that share its locale.
function templateLang(env: string): string {
  return process.env[env] || process.env.META_TEMPLATE_LANG || "en_US";
}

async function sendTemplate(
  phone: string,
  templateName: string | undefined,
  params: string[],
  lang: string = process.env.META_TEMPLATE_LANG || "en_US"
): Promise<boolean> {
  const to = normalizeIndianPhone(phone);
  if (!templateName) {
    console.error("Meta WhatsApp template send skipped: template name env var not set");
    return false;
  }
  if (!to) return false;

  return callGraphApi({
    to,
    type: "template",
    template: {
      name: templateName,
      language: { code: lang },
      // Omit entirely for a template whose body has no {{n}} placeholders
      // (e.g. clinic_welcome_booking_link) — Meta rejects an empty parameters
      // array against a body component that isn't expecting any.
      ...(params.length ? { components: [{ type: "body", parameters: params.map((text) => ({ type: "text", text })) }] } : {}),
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
  ], templateLang("META_TEMPLATE_LANG_CONFIRM"));
}

// Fired when staff cancels a booking from /admin.
export function sendBookingCancellation(appt: Pick<Appt, "name" | "phone" | "date" | "time" | "token">) {
  return sendTemplate(appt.phone, process.env.META_TEMPLATE_CANCEL, [
    appt.name,
    dateTimeLabel(appt),
    `Token #${appt.token}`,
  ], templateLang("META_TEMPLATE_LANG_CANCEL"));
}

// Fired by the Razorpay webhook once a payment link is paid. Optional —
// sendTemplate already no-ops (with a logged reason) when META_TEMPLATE_PAID
// isn't set, so a clinic that hasn't gotten this template approved yet just
// doesn't get this notice, same as any other unapproved template today.
export function sendPaymentReceived(appt: Pick<Appt, "name" | "phone" | "date" | "time" | "token" | "fee">) {
  return sendTemplate(appt.phone, process.env.META_TEMPLATE_PAID, [
    appt.name,
    dateTimeLabel(appt),
    `Token #${appt.token}`,
  ], templateLang("META_TEMPLATE_LANG_PAID"));
}

// Fired by /admin's Broadcast panel (running-late / closed-today notices to
// today's active queue). A template, not sendText, because most patients
// book via the website and never open a WhatsApp conversation — sendText
// only reaches the few who happen to have an active (<24h) chat.
export function sendClinicNotice(phone: string, name: string, message: string) {
  return sendTemplate(phone, process.env.META_TEMPLATE_NOTICE, [name, message], templateLang("META_TEMPLATE_LANG_NOTICE"));
}

// Static re-engagement nudge (zero body params — "Book Appointment" + "Call"
// buttons only). No automatic trigger wired yet; call this directly from
// wherever staff should be able to re-invite a specific patient onto WhatsApp.
export function sendWelcomeBookingLink(phone: string) {
  return sendTemplate(phone, process.env.META_TEMPLATE_WELCOME, [], templateLang("META_TEMPLATE_LANG_WELCOME"));
}

// Patient-verification code, sent outside any conversation window so it must
// be a template. This is the ownership proof for cancel / reschedule / pay —
// the code lands on the SIM that owns the appointment, which is the point.
// Expected template: a UTILITY "ortho_verification_code" with one {{1}} param
// for the 6-digit code. If META_TEMPLATE_OTP isn't set (template not yet
// approved in Meta), this no-ops with a logged reason, keeping the clinic on
// the old bare-phone-number path — degraded, not broken.
export function sendVerificationCode(phone: string, code: string) {
  return sendTemplate(phone, process.env.META_TEMPLATE_OTP, [code], templateLang("META_TEMPLATE_LANG_OTP"));
}
