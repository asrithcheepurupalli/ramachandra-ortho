// Staff-only email notice when a walk-in is added at the desk. Online and
// WhatsApp bookings get their new-appointment email from the Razorpay webhook
// (payments/webhook), but a walk-in never passes a payment gateway, so this
// route is what emails the clinic for one. It's fire-and-forget and non-blocking:
// the desk's add-to-queue already succeeded; if this notice fails the booking
// is still real, we just log it. Same staff gate as /api/admin/broadcast
// (requireStaff against the admin session) so a random request can't spam the
// clinic's inbox.
import { NextResponse, type NextRequest } from "next/server";
import { requireStaff } from "@/lib/auth-server";
import { sendNewAppointmentEmail } from "@/lib/mailer";
import { ymd, nowIST } from "@/lib/schedule";
import type { Source } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!(await requireStaff())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const appt = {
    token: typeof body?.token === "number" ? body.token : Number.NaN,
    name: typeof body?.name === "string" ? body.name.trim() : "",
    phone: typeof body?.phone === "string" ? body.phone.trim() : "",
    age: typeof body?.age === "number" ? body.age : 0,
    gender: (body?.gender === "M" || body?.gender === "F") ? body.gender as "M" | "F" : null,
    date: typeof body?.date === "string" ? body.date : "",
    time: typeof body?.time === "string" ? body.time : "",
    fee: typeof body?.fee === "number" ? body.fee : 0,
    source: ("walkin" as Source),
    patientCode: typeof body?.patientCode === "string" ? body.patientCode : null,
    locality: typeof body?.locality === "string" && body.locality.trim() ? body.locality.trim() : null,
  };

  if (!appt.name || !appt.phone || !appt.date || !appt.time || !Number.isFinite(appt.token)) {
    return NextResponse.json({ error: "Missing appointment fields" }, { status: 400 });
  }

  // Walk-ins are always today, but trust the client's date if supplied rather
  // than silently mangling a cross-midnight add.
  if (appt.date !== ymd(nowIST())) {
    return NextResponse.json({ error: "Walk-in must be for today" }, { status: 400 });
  }

  const ok = await sendNewAppointmentEmail(appt);
  return NextResponse.json({ notified: ok });
}
