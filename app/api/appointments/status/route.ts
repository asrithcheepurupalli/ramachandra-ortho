// Staff-only appointment status change. Used by /admin instead of a direct
// client-side Supabase write so a status change can also trigger a WhatsApp
// notice (cancellation) via Meta's WhatsApp Cloud API — that send has to
// happen server-side, outside the 24h window a template is required.
import { NextResponse, type NextRequest } from "next/server";
import { requireStaff } from "@/lib/auth-server";
import { dbSetStatusReturning, dbMarkRefunded } from "@/lib/db";
import { cancelAppointment } from "@/lib/refunds";
import { refundPayment } from "@/lib/razorpay";
import { reportError } from "@/lib/bugdesk";
import type { ApptStatus } from "@/lib/store";

const validStatuses: ApptStatus[] = ["reserved", "confirmed", "waiting", "consulting", "done", "cancelled"];
const isStatus = (v: unknown): v is ApptStatus => typeof v === "string" && (validStatuses as string[]).includes(v);

export async function POST(req: NextRequest) {
  if (!(await requireStaff())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { id, status } = body ?? {};
  if (typeof id !== "string" || !id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  if (!isStatus(status)) return NextResponse.json({ error: "invalid status" }, { status: 400 });

  try {
    // A cancel goes through the shared helper (flip status + WhatsApp notice,
    // no auto-refund — refunds are manual); every other status change is a
    // plain flip.
    const appt = status === "cancelled" ? await cancelAppointment(id) : await dbSetStatusReturning(id, status);

    // Desk / doctor cancels of a paid Razorpay booking put the money back:
    // this is clinic policy (admin-only — patient self-cancels via WhatsApp
    // stay manual, see lib/refunds.ts). The !refundId guard (plus dbMarkRefunded's
    // own conditional) makes a repeated cancel a no-op, never a double refund.
    if (status === "cancelled" && appt.paid && appt.paidVia === "razorpay" && appt.paymentId && !appt.refundId) {
      const refund = await refundPayment(appt.paymentId);
      if (refund?.id) {
        await dbMarkRefunded(appt.id, refund.id);
        appt.refundId = refund.id;
        appt.refundedAt = Date.now();
      } else {
        // Never silent: the cancel already happened and the notice went out.
        // Flag the desk to refund manually from the Razorpay dashboard (then
        // "Mark refunded" in admin records it).
        await reportError("appointments/status", new Error(`auto-refund failed for ${appt.id} (payment ${appt.paymentId})`), { severity: "warning", info: { channel: "refund", appt: appt.id } });
      }
    }

    return NextResponse.json({ appointment: appt });
  } catch (err) {
    console.error("/api/appointments/status", err);
    await reportError("appointments/status", err, { severity: "warning" });
    return NextResponse.json({ error: "Could not update status" }, { status: 500 });
  }
}
