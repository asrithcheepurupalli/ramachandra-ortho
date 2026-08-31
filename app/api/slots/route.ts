// Bookable slots for a date. Server-only because anon has no RLS read access
// to appointments (patient data) — the client can't compute "taken" itself.
import { NextResponse, type NextRequest } from "next/server";
import { dbTakenSlots, dbLoadSchedule } from "@/lib/db";
import { slotsFor } from "@/lib/schedule";

export async function GET(req: NextRequest) {
  const date = req.nextUrl.searchParams.get("date");
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "date must be YYYY-MM-DD" }, { status: 400 });
  }

  try {
    const [taken, sched] = await Promise.all([dbTakenSlots(date), dbLoadSchedule()]);
    const slots = slotsFor(new Date(date + "T00:00:00"), taken, sched);
    return NextResponse.json({ slots });
  } catch (err) {
    console.error("/api/slots", err);
    return NextResponse.json({ error: "Could not load slots" }, { status: 500 });
  }
}
