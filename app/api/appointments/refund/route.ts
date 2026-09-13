// Staff-only: records that a Razorpay refund was already issued manually from
// the Razorpay dashboard (clinic policy — see lib/refunds.ts). Validates the
// refund ID against Razorpay (format + existence + payment_id match) before
// writing, so a staff typo or a mismatched ID is caught before it corrupts
// the appointment record.
import { NextResponse, type NextRequest } from "next/server";
import { requireStaff } from "@/lib/auth-server";
import { dbGetAppt, dbMarkRefunded } from "@/lib/db";
import { fetchRefund } from "@/lib/razorpay";
import { reportError } from "@/lib/bugdesk";

export async function POST(req: NextRequest) {
  if (!(await requireStaff())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { id, refundId } = body ?? {};
  if (typeof id !== "string" || !id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  if (typeof refundId !== "string" || !refundId.trim()) return NextResponse.json({ error: "refundId is required" }, { status: 400 });

  const rid = refundId.trim();
  if (!/^rfnd_/.test(rid)) return NextResponse.json({ error: "Invalid refund ID format (must start with rfnd_)" }, { status: 400 });

  // Verify the refund exists on Razorpay and belongs to this appointment's payment
  const appt = await dbGetAppt(id);
  if (!appt) return NextResponse.json({ error: "Appointment not found" }, { status: 404 });
  if (!appt.paymentId) return NextResponse.json({ error: "Appointment has no recorded Razorpay payment" }, { status: 400 });

  const rzRefund = await fetchRefund(rid);
  if (!rzRefund) return NextResponse.json({ error: "Refund ID not found on Razorpay" }, { status: 400 });
  if (rzRefund.payment_id !== appt.paymentId) {
    return NextResponse.json({ error: "Refund does not belong to this appointment's payment" }, { status: 400 });
  }

  try {
    await dbMarkRefunded(id, rid);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("/api/appointments/refund", err);
    await reportError("appointments/refund", err, { severity: "warning" });
    return NextResponse.json({ error: "Could not record refund" }, { status: 500 });
  }
}
