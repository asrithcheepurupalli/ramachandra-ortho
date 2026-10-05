// Staff-only appointment status change. Used by /admin instead of a direct
// client-side Supabase write so a status change can also trigger a WhatsApp
// notice (cancellation) via Meta's WhatsApp Cloud API — that send has to
// happen server-side, outside the 24h window a template is required.
import { NextResponse, type NextRequest } from "next/server";
import { requireStaffEmail } from "@/lib/auth-server";
import { dbGetAppt, dbSetStatusReturning, dbMarkRefunded } from "@/lib/db";
import { recordCancelAudit } from "@/lib/cancel-audit";
import { cancelAppointment } from "@/lib/refunds";
import { refundPayment } from "@/lib/razorpay";
import { reportError } from "@/lib/bugdesk";
import type { ApptStatus } from "@/lib/store";

const validStatuses: ApptStatus[] = ["reserved", "confirmed", "waiting", "consulting", "done", "cancelled"];
const isStatus = (v: unknown): v is ApptStatus => typeof v === "string" && (validStatuses as string[]).includes(v);

export async function POST(req: NextRequest) {
  const staffEmail = await requireStaffEmail();
  if (!staffEmail) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

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
    // Snapshot the pre-cancel status for the audit trail. Best effort: a
    // failed read must never stop the cancel itself.
    const prevStatus = status === "cancelled" ? (await dbGetAppt(id).catch(() => null))?.status ?? null : null;

    // A cancel goes through the shared helper (flip status + WhatsApp notice;
    // the helper itself moves no money, the refund is handled just below);
    // every other status change is a plain flip.
    const appt = status === "cancelled" ? await cancelAppointment(id) : await dbSetStatusReturning(id, status);

    // A staff cancel of a paid Razorpay booking puts the money back
    // automatically (added 2026-09-12). This is the ONLY code path that issues a
    // refund: patients cannot cancel (the bot and site both send them to the
    // desk) and the payment-timeout cron only touches unpaid holds. The admin
    // cancel dialog says so up front. The !refundId guard (plus
    // dbMarkRefunded's own conditional) makes a repeated cancel a no-op, never
    // a double refund. Every cancel is also written to cancel_audit.
    if (status === "cancelled") {
      let refundId: string | null = null;
      let refundError: string | null = null;
      if (appt.paid && appt.paidVia === "razorpay" && appt.paymentId && !appt.refundId) {
        const refund = await refundPayment(appt.paymentId);
        if (refund?.id) {
          await dbMarkRefunded(appt.id, refund.id);
          appt.refundId = refund.id;
          appt.refundedAt = Date.now();
          refundId = refund.id;
        } else {
          refundError = "Razorpay refund call failed";
          // Never silent: the cancel already happened and the notice went out.
          // Flag the desk to refund manually from the Razorpay dashboard (then
          // "Mark refunded" in admin records it).
          await reportError("appointments/status", new Error(`auto-refund failed for ${appt.id} (payment ${appt.paymentId})`), { severity: "warning", info: { channel: "refund", appt: appt.id } });
        }
      }
      await recordCancelAudit({ appt, prevStatus, staffEmail, refundId, refundError, req });
    }

    return NextResponse.json({ appointment: appt });
  } catch (err) {
    console.error("/api/appointments/status", err);
    await reportError("appointments/status", err, { severity: "warning" });
    return NextResponse.json({ error: "Could not update status" }, { status: 500 });
  }
}
