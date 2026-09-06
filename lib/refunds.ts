// Shared auto-refund for "a paid appointment is being cancelled". Both the
// patient self-service cancel and the staff cancel call this. It must never
// block the cancellation itself: a refund failure is logged and the cancel
// proceeds, because a patient's appointment being cancelled should not depend
// on whether a bank wire goes through. The clinic can chase the failed refund
// from the admin view (a live refunded_at vs null column).
// ─────────────────────────────────────────────────────────────────────────────
import type { Appt } from "@/lib/store";
import { refundPayment } from "@/lib/razorpay";
import { dbGetAppt, dbMarkRefunded, dbSetStatusReturning } from "@/lib/db";
import { sendBookingCancellation, sendClinicNotice } from "@/lib/meta-whatsapp";

export type RefundResult = "refunded" | "nothing_to_refund" | "not_paid" | "refund_failed";

// Inspects one appointment: if it was paid via Razorpay and hasn't been
// refunded yet, issues a full refund and records it. Returns what happened so
// callers can log it. Never throws — every failure path is swallowed into a
// result value (matching lib/razorpay.ts's "never break the caller" posture).
export async function attemptRefund(appt: Pick<Appt, "id" | "paid" | "paidVia" | "paymentId" | "refundId">): Promise<RefundResult> {
  if (!appt.paid) return "not_paid";
  if (appt.paidVia !== "razorpay") return "not_paid"; // cash-paid = already settled by hand, nothing to reverse
  if (appt.refundId) return "nothing_to_refund"; // idempotent: never double-refund
  if (!appt.paymentId) return "nothing_to_refund"; // paid_via faked or pre-migration; no payment id to refund against

  try {
    const refund = await refundPayment(appt.paymentId);
    if (!refund) {
      console.error(`attemptRefund: refund returned null for appt ${appt.paid ? "(paid)" : "(unpaid)"} [paymentId present]`);
      return "refund_failed";
    }
    await dbMarkRefunded(appt.id, refund.id);
    return "refunded";
  } catch (err) {
    console.error("attemptRefund: unexpected error", err);
    return "refund_failed";
  }
}

// The one place every real cancellation path should go through: fetches the
// appointment, refunds it if it was paid via Razorpay, flips the status, and
// sends the patient both WhatsApp notices (cancellation + refund, when there
// was one) using the clinic_notice template since there's no dedicated
// "refund processed" template approved yet. Mirrors attemptRefund's posture:
// a notify failure is logged, never thrown, so it can't block the cancel.
export async function cancelAppointmentWithRefund(id: string): Promise<Appt> {
  const before = await dbGetAppt(id);
  let refunded = false;
  if (before && before.paid && before.paidVia === "razorpay") {
    const outcome = await attemptRefund(before);
    refunded = outcome === "refunded";
    if (outcome === "refund_failed") {
      console.error(`cancelAppointmentWithRefund: refund failed for appt ${id}`);
    }
  }

  const appt = await dbSetStatusReturning(id, "cancelled");

  try {
    await sendBookingCancellation(appt);
  } catch (err) {
    console.error("cancelAppointmentWithRefund: cancellation notice failed", err);
  }

  if (refunded) {
    try {
      await sendClinicNotice(
        appt.phone,
        appt.name,
        `Your payment for Token #${appt.token} has been refunded. It should reflect in your account within 5 to 7 business days.`
      );
    } catch (err) {
      console.error("cancelAppointmentWithRefund: refund notice failed", err);
    }
  }

  return appt;
}