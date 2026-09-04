// Public patient self-service reschedule. Same phone-ownership check as
// cancel, then reuses the booking confirmation template — "your appointment
// is confirmed for X" reads fine for a moved booking too, no new template
// needed.
import { NextResponse, type NextRequest } from "next/server";
import { dbActiveAppointmentsByPhone, dbRescheduleAppointment } from "@/lib/db";
import { sendBookingConfirmation } from "@/lib/meta-whatsapp";
import { SlotTakenError } from "@/lib/errors";
import { ymd, nowIST } from "@/lib/schedule";

const RATE_LIMIT = 8;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const recentHits = new Map<string, number[]>();
function isRateLimited(key: string): boolean {
  const now = Date.now();
  const hits = (recentHits.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  hits.push(now);
  recentHits.set(key, hits);
  return hits.length > RATE_LIMIT;
}

export async function POST(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (isRateLimited(ip)) return NextResponse.json({ error: "Too many requests. Please try again in a bit." }, { status: 429 });

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  const { id, phone, date, time } = body ?? {};
  if (typeof id !== "string" || !id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  if (typeof phone !== "string" || !phone.trim()) return NextResponse.json({ error: "phone is required" }, { status: 400 });
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ error: "date must be YYYY-MM-DD" }, { status: 400 });
  if (typeof time !== "string" || !/^\d{2}:\d{2}$/.test(time)) return NextResponse.json({ error: "time must be HH:MM" }, { status: 400 });
  if (date < ymd(nowIST())) return NextResponse.json({ error: "That date has already passed" }, { status: 400 });

  try {
    const owned = await dbActiveAppointmentsByPhone(phone.trim());
    if (!owned.some((a) => a.id === id)) return NextResponse.json({ error: "Appointment not found" }, { status: 404 });

    const appt = await dbRescheduleAppointment(id, date, time);
    try { await sendBookingConfirmation(appt); } catch (err) { console.error("/api/appointments/reschedule: notify failed", err); }
    return NextResponse.json({ appointment: appt });
  } catch (err) {
    if (err instanceof SlotTakenError) return NextResponse.json({ error: "That time isn't available. Please pick another slot." }, { status: 409 });
    console.error("/api/appointments/reschedule", err);
    return NextResponse.json({ error: "Could not reschedule appointment" }, { status: 500 });
  }
}
