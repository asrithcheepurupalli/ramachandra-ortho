// Shared cancellation for "an appointment is being cancelled". Both the staff
// cancel (admin/doctor) and the WhatsApp webhook route funnel here. It flips
// the status to cancelled and sends the patient a WhatsApp cancellation
// notice. Per clinic policy it does NOT refund: any refund is handled
// manually by the front desk in the Razorpay dashboard, never automatically.
// A notify failure is logged, never thrown, so it can't block the cancel.
// ─────────────────────────────────────────────────────────────────────────────
import type { Appt } from "@/lib/store";
import { dbSetStatusReturning } from "@/lib/db";
import { sendBookingCancellation } from "@/lib/meta-whatsapp";

// The one place a real cancellation goes through: flip the status and tell the
// patient over WhatsApp. No money moves here — cancellations and refunds are
// handled by the clinic staff directly.
export async function cancelAppointment(id: string): Promise<Appt> {
  const appt = await dbSetStatusReturning(id, "cancelled");
  try {
    await sendBookingCancellation(appt);
  } catch (err) {
    console.error("cancelAppointment: cancellation notice failed", err);
  }
  return appt;
}
