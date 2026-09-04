// Staff-only manual nudge: sends the clinic_welcome_booking_link template
// (Book Appointment + Call buttons, no dynamic content) to one patient. Used
// from the Patients tab to re-invite someone who booked via the website or
// as a walk-in onto WhatsApp, where the bot can help them next time.
import { NextResponse, type NextRequest } from "next/server";
import { requireStaff } from "@/lib/auth-server";
import { sendWelcomeBookingLink } from "@/lib/meta-whatsapp";

export async function POST(req: NextRequest) {
  if (!(await requireStaff())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const phone = typeof body?.phone === "string" ? body.phone.trim() : "";
  if (!phone) return NextResponse.json({ error: "phone is required" }, { status: 400 });

  const sent = await sendWelcomeBookingLink(phone);
  if (!sent) return NextResponse.json({ error: "Could not send" }, { status: 502 });
  return NextResponse.json({ ok: true });
}
