// Public patient self-service cancel. The phone must match one of the
// appointment's owner's own active appointments before it can be cancelled —
// a guessed id alone isn't enough, since there's no login to check instead.
import { NextResponse, type NextRequest } from "next/server";
import { dbActiveAppointmentsByPhone, dbSetStatusReturning } from "@/lib/db";
import { sendBookingCancellation } from "@/lib/meta-whatsapp";

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
  const { id, phone } = body ?? {};
  if (typeof id !== "string" || !id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  if (typeof phone !== "string" || !phone.trim()) return NextResponse.json({ error: "phone is required" }, { status: 400 });

  try {
    const owned = await dbActiveAppointmentsByPhone(phone.trim());
    if (!owned.some((a) => a.id === id)) return NextResponse.json({ error: "Appointment not found" }, { status: 404 });

    const appt = await dbSetStatusReturning(id, "cancelled");
    try { await sendBookingCancellation(appt); } catch (err) { console.error("/api/appointments/cancel: notify failed", err); }
    return NextResponse.json({ appointment: appt });
  } catch (err) {
    console.error("/api/appointments/cancel", err);
    return NextResponse.json({ error: "Could not cancel appointment" }, { status: 500 });
  }
}
