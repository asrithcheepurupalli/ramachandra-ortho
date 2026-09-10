// Bookable slots for a date. Server-only because anon has no RLS read access
// to appointments (patient data).
import { NextResponse, type NextRequest } from "next/server";
import { dbLoadSchedule } from "@/lib/db";
import { allSlotsFor } from "@/lib/schedule";
import { reportError } from "@/lib/bugdesk";

export async function GET(req: NextRequest) {
  const date = req.nextUrl.searchParams.get("date");
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "date must be YYYY-MM-DD" }, { status: 400 });
  }

  try {
    const sched = await dbLoadSchedule();
    const slots = allSlotsFor(new Date(date + "T00:00:00"), sched);
    return NextResponse.json({ slots });
  } catch (err) {
    console.error("/api/slots", err);
    await reportError("slots", err, { severity: "warning" });
    return NextResponse.json({ error: "Could not load slots" }, { status: 500 });
  }
}
