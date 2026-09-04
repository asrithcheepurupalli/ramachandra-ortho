// Razorpay webhook — the authoritative write path for "this appointment is
// paid" (the callback_url redirect in components/MyAppointment.tsx is UX
// polish only, not a source of truth). Same posture as the WhatsApp webhook:
// always ack 200 quickly so Razorpay doesn't retry-storm a slow/erroring
// handler; a bad signature or unhandled event is logged and swallowed.
import { NextResponse, type NextRequest } from "next/server";
import { dbMarkPaidByPaymentLink } from "@/lib/db";
import { sendPaymentReceived } from "@/lib/meta-whatsapp";
import { verifyWebhookSignature } from "@/lib/razorpay";

export async function POST(req: NextRequest) {
  const rawBody = await req.text();

  if (!verifyWebhookSignature(rawBody, req.headers.get("x-razorpay-signature"))) {
    console.error("Razorpay webhook: bad signature");
    return new NextResponse("OK", { status: 200 });
  }

  try {
    const payload = JSON.parse(rawBody);
    if (payload?.event !== "payment_link.paid") return new NextResponse("OK", { status: 200 });

    const paymentLinkId: string | undefined = payload?.payload?.payment_link?.entity?.id;
    if (!paymentLinkId) return new NextResponse("OK", { status: 200 });

    const appt = await dbMarkPaidByPaymentLink(paymentLinkId);
    if (appt) {
      try { await sendPaymentReceived(appt); } catch (err) { console.error("payments/webhook: notify failed", err); }
    }
  } catch (err) {
    console.error("/api/payments/webhook", err);
  }

  return new NextResponse("OK", { status: 200 });
}
