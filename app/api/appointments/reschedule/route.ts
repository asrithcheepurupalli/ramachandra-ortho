// Public patient self-service reschedule. Same two-step ownership proof as
// cancel (phone owns an active appointment AND verified itself with a
// one-time SIM code), then reuses the booking confirmation template — "your
// appointment is confirmed for X" reads fine for a moved booking too, no new
// template needed.
import { NextResponse, type NextRequest } from "next/server";
import { dbActiveAppointmentsByPhone, dbRescheduleAppointment } from "@/lib/db";
import { sendBookingConfirmation } from "@/lib/meta-whatsapp";
import { sendRescheduledEmail } from "@/lib/mailer";
import { SlotTakenError } from "@/lib/errors";
import { ymd, nowIST } from "@/lib/schedule";
import { otpVerified, otpEnabled } from "@/lib/otp";
import { reportError } from "@/lib/bugdesk";
import { isRateLimited } from "@/lib/rate-limit";

const RATE_LIMIT = 8;
const RATE_WINDOW_MS = 10 * 60 * 1000;

export async function POST(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (await isRateLimited(`reschedule:${ip}`, RATE_LIMIT, RATE_WINDOW_MS)) {
    return NextResponse.json({ error: "Too many requests. Please try again in a bit." }, { status: 429 });
  }

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  const { id, phone, date, time } = body ?? {};
  if (typeof id !== "string" || !id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  if (typeof phone !== "string" || !phone.trim()) return NextResponse.json({ error: "phone is required" }, { status: 400 });
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ error: "date must be YYYY-MM-DD" }, { status: 400 });
  if (typeof time !== "string" || !/^\d{2}:\d{2}$/.test(time)) return NextResponse.json({ error: "time must be HH:MM" }, { status: 400 });
  if (date < ymd(nowIST())) return NextResponse.json({ error: "That date has already passed" }, { status: 400 });

  try {
    const owned = await dbActiveAppointmentsByPhone(phone.trim());
    const owns = owned.some((a) => a.id === id);
    const otpOk = await otpVerified(phone.trim());
    const gateOk = !otpEnabled() || otpOk;
    if (!owns) return NextResponse.json({ error: "Appointment not found" }, { status: 404 });
    if (!gateOk) {
      return NextResponse.json({ error: "Verify your number to continue", otpRequired: true }, { status: 401 });
    }

    const appt = await dbRescheduleAppointment(id, date, time);
    const whatsappOk = await sendBookingConfirmation(appt);
    if (!whatsappOk) await reportError("appointments/reschedule", new Error("WhatsApp notify failed"), { severity: "warning", info: { channel: "whatsapp", appt: appt.id } });
    const emailOk = await sendRescheduledEmail(appt);
    if (!emailOk) await reportError("appointments/reschedule", new Error("email notify failed"), { severity: "warning", info: { channel: "email", appt: appt.id } });
    return NextResponse.json({ appointment: appt });
  } catch (err) {
    if (err instanceof SlotTakenError) { return NextResponse.json({ error: "That time isn't available. Please pick another slot." }, { status: 409 }); }
    console.error("/api/appointments/reschedule", err);
    await reportError("appointments/reschedule", err, { severity: "warning" });
    return NextResponse.json({ error: "Could not reschedule appointment" }, { status: 500 });
  }
}
