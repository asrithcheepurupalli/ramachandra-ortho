// ─────────────────────────────────────────────────────────────────────────────
// Shared cancellation for "an appointment is being cancelled": flips the status
// to cancelled and sends the patient a WhatsApp cancellation notice. Only the
// staff status route (/api/appointments/status) calls it; patients cannot
// cancel on their own. This helper moves no money. The automatic refund for a
// paid Razorpay booking happens in that route right after this returns, and is
// recorded in cancel_audit. A notify failure is logged, never thrown, so it
// can't block the cancel.
// ─────────────────────────────────────────────────────────────────────────────
import type { Appt } from "@/lib/store";
import { dbSetStatusReturning } from "@/lib/db";
import { sendBookingCancellation } from "@/lib/meta-whatsapp";

// The one place a real cancellation goes through: flip the status and tell the
// patient over WhatsApp. No money moves here (see the header).
export async function cancelAppointment(id: string): Promise<Appt> {
  const appt = await dbSetStatusReturning(id, "cancelled");
  try {
    await sendBookingCancellation(appt);
  } catch (err) {
    console.error("cancelAppointment: cancellation notice failed", err);
  }
  return appt;
}
