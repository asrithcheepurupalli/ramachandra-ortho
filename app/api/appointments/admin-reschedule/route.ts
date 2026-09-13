// Staff-only reschedule: moves a confirmed appointment to a new date/time
// without requiring the patient's phone or OTP — the front-desk staff is
// already authenticated. Sends the booking-confirmation WhatsApp template
// (reads fine as a reschedule confirmation) rather than a cancellation.
import { NextResponse, type NextRequest } from "next/server";
import { requireStaff } from "@/lib/auth-server";
import { dbRescheduleAppointment } from "@/lib/db";
import { sendBookingConfirmation } from "@/lib/meta-whatsapp";
import { sendRescheduledEmail } from "@/lib/mailer";
import { reportError } from "@/lib/bugdesk";
import { SlotTakenError } from "@/lib/errors";
import { ymd, nowIST } from "@/lib/schedule";

export async function POST(req: NextRequest) {
  if (!(await requireStaff())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }

  const { id, date, time } = body ?? {};
  if (typeof id !== "string" || !id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ error: "date must be YYYY-MM-DD" }, { status: 400 });
  if (typeof time !== "string" || !/^\d{2}:\d{2}$/.test(time)) return NextResponse.json({ error: "time must be HH:MM" }, { status: 400 });
  if (date < ymd(nowIST())) return NextResponse.json({ error: "That date has already passed" }, { status: 400 });

  try {
    const appt = await dbRescheduleAppointment(id, date, time);
    const whatsappOk = await sendBookingConfirmation(appt);
    if (!whatsappOk) await reportError("appointments/admin-reschedule", new Error("WhatsApp notify failed"), { severity: "warning", info: { appt: appt.id } });
    const emailOk = await sendRescheduledEmail(appt);
    if (!emailOk) await reportError("appointments/admin-reschedule", new Error("email notify failed"), { severity: "warning", info: { appt: appt.id } });
    return NextResponse.json({ appointment: appt });
  } catch (err) {
    if (err instanceof SlotTakenError) {
      return NextResponse.json({ error: "That slot is not available. Pick another time." }, { status: 409 });
    }
    if (err instanceof Error && err.message === "not_found") {
      return NextResponse.json({ error: "Appointment not found or cannot be rescheduled" }, { status: 404 });
    }
    console.error("/api/appointments/admin-reschedule", err);
    await reportError("appointments/admin-reschedule", err, { severity: "warning" });
    return NextResponse.json({ error: "Could not reschedule appointment" }, { status: 500 });
  }
}
