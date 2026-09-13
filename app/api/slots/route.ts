// Bookable slots endpoint. Two modes:
//
//   GET /api/slots?date=YYYY-MM-DD          — single day (legacy, still works)
//   GET /api/slots?from=YYYY-MM-DD&count=N  — N days starting from `from`
//
// Server-only because anon has no RLS read access to appointments (patient
// data). The range form loads dbLoadSchedule() once and computes all days in
// pure JS, cutting the BookForm bootstrap from 14 parallel DB round-trips to 1.
import { NextResponse, type NextRequest } from "next/server";
import { dbLoadSchedule } from "@/lib/db";
import { allSlotsFor, ymd } from "@/lib/schedule";
import { reportError } from "@/lib/bugdesk";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_COUNT = 31;

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const date = searchParams.get("date");
  const from = searchParams.get("from");
  const countRaw = searchParams.get("count");

  // Single-day mode (legacy)
  if (date) {
    if (!DATE_RE.test(date)) return NextResponse.json({ error: "date must be YYYY-MM-DD" }, { status: 400 });
    try {
      const sched = await dbLoadSchedule();
      return NextResponse.json({ slots: allSlotsFor(new Date(date + "T00:00:00"), sched) });
    } catch (err) {
      await reportError("slots", err, { severity: "warning" });
      return NextResponse.json({ error: "Could not load slots" }, { status: 500 });
    }
  }

  // Range mode: ?from=YYYY-MM-DD&count=N
  if (from) {
    if (!DATE_RE.test(from)) return NextResponse.json({ error: "from must be YYYY-MM-DD" }, { status: 400 });
    const count = Math.min(parseInt(countRaw ?? "14", 10) || 14, MAX_COUNT);
    try {
      const sched = await dbLoadSchedule();
      const start = new Date(from + "T00:00:00");
      const days = Array.from({ length: count }, (_, i) => {
        const d = new Date(start);
        d.setDate(start.getDate() + i);
        return { date: ymd(d), slots: allSlotsFor(d, sched) };
      });
      return NextResponse.json({ days });
    } catch (err) {
      await reportError("slots", err, { severity: "warning" });
      return NextResponse.json({ error: "Could not load slots" }, { status: 500 });
    }
  }

  return NextResponse.json({ error: "Provide either date=YYYY-MM-DD or from=YYYY-MM-DD&count=N" }, { status: 400 });
}
