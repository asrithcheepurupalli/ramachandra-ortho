// ─────────────────────────────────────────────────────────────────────────────
// Paper trail for staff cancels (table: cancel_audit, migration 019). Every
// desk device shares one login, so the email alone can't say who pressed
// Cancel; the user agent and IP are what tell devices apart. Never throws: an
// audit failure must not block or undo a cancel (or its refund) that already
// happened, so errors go to the Bug Desk instead.
// ─────────────────────────────────────────────────────────────────────────────
import type { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { reportError } from "@/lib/bugdesk";
import type { Appt, ApptStatus } from "@/lib/store";

export type CancelAuditInput = {
  appt: Appt;
  prevStatus: ApptStatus | null;
  staffEmail: string;
  refundId: string | null;
  refundError: string | null;
  req: NextRequest;
};

export async function recordCancelAudit({ appt, prevStatus, staffEmail, refundId, refundError, req }: CancelAuditInput): Promise<void> {
  try {
    // Vercel puts the real client first in x-forwarded-for.
    const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || null;
    const { error } = await supabaseAdmin().from("cancel_audit").insert({
      appointment_id: appt.id,
      token: appt.token,
      patient_name: appt.name,
      phone: appt.phone,
      appt_date: appt.date,
      appt_time: appt.time,
      prev_status: prevStatus,
      fee: appt.fee,
      paid: appt.paid,
      paid_via: appt.paidVia,
      refund_issued: refundId !== null,
      refund_id: refundId,
      refund_error: refundError,
      staff_email: staffEmail,
      ip,
      user_agent: req.headers.get("user-agent"),
    });
    if (error) throw error;
  } catch (err) {
    console.error("cancel-audit: could not record cancel", err);
    await reportError("appointments/status", err, { severity: "warning", info: { channel: "cancel_audit", appt: appt.id } });
  }
}
