// Razorpay webhook — the authoritative write path for "this appointment is
// paid" (the callback_url redirect in components/MyAppointment.tsx is UX
// polish only, not a source of truth). Same posture as the WhatsApp webhook:
// always ack 200 quickly so Razorpay doesn't retry-storm a slow/erroring
// handler; a bad signature or unhandled event is logged and swallowed.
import { NextResponse, type NextRequest } from "next/server";
import { dbMarkPaidByPaymentLink } from "@/lib/db";
import { sendPaymentReceived, sendBookingConfirmation } from "@/lib/meta-whatsapp";
import { sendNewAppointmentEmail } from "@/lib/mailer";
import { verifyWebhookSignature } from "@/lib/razorpay";
import { report, reportError } from "@/lib/bugdesk";

export async function POST(req: NextRequest) {
  const rawBody = await req.text();

  if (!verifyWebhookSignature(rawBody, req.headers.get("x-razorpay-signature"))) {
    console.error("Razorpay webhook: bad signature");
    // A signature mismatch on the authoritative payment path: something is
    // wrong with auth itself, not a single event — escalate immediately.
    await report({ source: "payments/webhook", message: "Razorpay webhook delivered a bad signature", severity: "critical" });
    return new NextResponse("OK", { status: 200 });
  }

  try {
    const payload = JSON.parse(rawBody);
    if (payload?.event !== "payment_link.paid") return new NextResponse("OK", { status: 200 });

    const paymentLinkId: string | undefined = payload?.payload?.payment_link?.entity?.id;
    const paymentId: string | undefined = payload?.payload?.payment?.entity?.id;
    const capturedAmountPaise: number | undefined = payload?.payload?.payment?.entity?.amount;
    if (!paymentLinkId) return new NextResponse("OK", { status: 200 });

    const appt = await dbMarkPaidByPaymentLink(paymentLinkId, paymentId, capturedAmountPaise);
    if (appt) {
      const whatsappOk = await sendPaymentReceived(appt);
      if (!whatsappOk) await reportError("payments/webhook", new Error("WhatsApp payment notify failed"), { severity: "warning", info: { channel: "whatsapp", appt: appt.id } });
      const confirmOk = await sendBookingConfirmation(appt);
      if (!confirmOk) await reportError("payments/webhook", new Error("WhatsApp confirmation notify failed"), { severity: "warning", info: { channel: "whatsapp_confirm", appt: appt.id } });
      const emailOk = await sendNewAppointmentEmail(appt);
      if (!emailOk) await reportError("payments/webhook", new Error("email notify failed"), { severity: "warning", info: { channel: "email", appt: appt.id } });
    } else {
      // Money was captured at Razorpay but no payment_pending row matched.
      // Either a duplicate delivery (already paid — harmless) or the clinic's
      // payment-timeout cron cancelled the row before this webhook landed.
      // Log loudly either way so the clinic can reconcile captured money.
      console.error("payments/webhook: paid event matched no payment_pending row (duplicate or slot expired)", JSON.stringify({ paymentLinkId, paymentId }));
      // Money was captured — even if the row raced ahead, the clinic must
      // reconcile it. Critical so it lands as an instant alert, not a digest.
      await report({ source: "payments/webhook", message: "Paid event matched no payment_pending row — money to reconcile", severity: "critical", info: { paymentLinkId, paymentId } });
    }
  } catch (err) {
    console.error("/api/payments/webhook", err);
    await reportError("payments/webhook", err, { severity: "critical" });
  }

  return new NextResponse("OK", { status: 200 });
}
