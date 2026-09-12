// Staff-only manual nudge from the Patients tab. When the patient's last
// booking (date + time) is passed, the send uses the *structured* reminder
// template — that patient's own date + time + a "View your appointment"
// button — so the nudge carries real appointment info instead of a generic
// invite. Without date/time (no upcoming visit on file), it falls back to the
// static clinic_welcome_booking_link (Book Appointment + Call buttons) so the
// desk can re-invite a website/walk-in patient onto WhatsApp. Fallback also
// covers the still-unapproved-template gap (META_TEMPLATE_REMINDER unset).
import { NextResponse, type NextRequest } from "next/server";
import { requireStaff } from "@/lib/auth-server";
import { sendWelcomeBookingLink, sendReminder } from "@/lib/meta-whatsapp";

export async function POST(req: NextRequest) {
  if (!(await requireStaff())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const phone = typeof body?.phone === "string" ? body.phone.trim() : "";
  if (!phone) return NextResponse.json({ error: "phone is required" }, { status: 400 });

  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const date = typeof body?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : "";
  const time = typeof body?.time === "string" && /^\d{2}:\d{2}$/.test(body.time) ? body.time : "";

  // Appointment info present and the reminder template exists → per-patient
  // date + time + View button. Anything short of that degrades to the generic
  // welcome invite (unchanged behaviour for patients with no upcoming visit).
  const sent = name && date && time && process.env.META_TEMPLATE_REMINDER
    ? await sendReminder(phone, name, date, time)
    : await sendWelcomeBookingLink(phone);
  if (!sent) return NextResponse.json({ error: "Could not send" }, { status: 502 });
  return NextResponse.json({ ok: true });
}
