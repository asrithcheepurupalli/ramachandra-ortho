// ─────────────────────────────────────────────────────────────────────────────
// Razorpay Payment Links API — a hosted checkout page reached by URL, not an
// embedded widget. Fits a site with no login and a WhatsApp bot that just
// needs to hand someone a link. Raw fetch, no SDK, same posture as
// lib/meta-whatsapp.ts: a payment-link failure must never break the page.
// ─────────────────────────────────────────────────────────────────────────────
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Appt } from "@/lib/store";

const API_BASE = "https://api.razorpay.com/v1";

function authHeader(): string | null {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) return null;
  return `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`;
}

function normalizeIndianPhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  return null;
}

// Creates a Payment Link for one appointment's fee. Returns null on any
// failure (missing keys, non-2xx response, network error) — callers surface
// that as "couldn't start payment right now", never a thrown exception that
// could take down a page render.
export async function createPaymentLink(
  appt: Pick<Appt, "id" | "name" | "phone" | "fee">
): Promise<{ id: string; short_url: string } | null> {
  const auth = authHeader();
  if (!auth) {
    console.error("Razorpay payment link skipped: RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET not set");
    return null;
  }

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL;
  const contact = normalizeIndianPhone(appt.phone);

  try {
    const res = await fetch(`${API_BASE}/payment_links`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({
        amount: appt.fee * 100,
        currency: "INR",
        reference_id: appt.id,
        description: "Consultation fee",
        customer: { name: appt.name, ...(contact ? { contact } : {}) },
        notify: { sms: false, email: false },
        ...(siteUrl
          ? {
              callback_url: `${siteUrl}/my-appointment?phone=${encodeURIComponent(appt.phone)}&paid=${appt.id}`,
              callback_method: "get",
            }
          : {}),
      }),
    });
    if (!res.ok) {
      console.error("Razorpay payment link create failed", res.status, await res.text().catch(() => ""));
      return null;
    }
    const data = await res.json();
    if (!data?.id || !data?.short_url) return null;
    return { id: data.id as string, short_url: data.short_url as string };
  } catch (err) {
    console.error("Razorpay payment link create error", err);
    return null;
  }
}

// Razorpay signs webhook deliveries with X-Razorpay-Signature: a bare hex
// HMAC-SHA256 digest of the raw body using the webhook secret (set when the
// webhook URL is added in Dashboard -> Settings -> Webhooks). Same
// constant-time compare pattern as verifySignature in lib/meta-whatsapp.ts.
export function verifyWebhookSignature(rawBody: string, signatureHeader: string | null): boolean {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret || !signatureHeader) return false;

  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const expectedBuf = Buffer.from(expected, "hex");
  const providedBuf = Buffer.from(signatureHeader, "hex");
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}
