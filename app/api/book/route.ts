// Creates a booking. The single place token assignment + patient dedupe
// happen, so every booking source (website today) goes through it.
import { NextResponse, type NextRequest } from "next/server";
import { dbAddBooking, dbLoadSchedule, dbTakenSlots } from "@/lib/db";
import { sendBookingConfirmation } from "@/lib/meta-whatsapp";
import { SlotTakenError } from "@/lib/errors";
import { slotsFor, ymd, nowIST } from "@/lib/schedule";

type Source = "website" | "whatsapp" | "walkin";
const isSource = (v: unknown): v is Source => v === "website" || v === "whatsapp" || v === "walkin";

// Best-effort per-instance flood guard — no shared store across serverless
// instances, so this isn't a hard limit, but it blunts a casual script
// hammering this public endpoint with junk reservations.
const RATE_LIMIT = 5;
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
  if (isRateLimited(ip)) {
    return NextResponse.json({ error: "Too many requests. Please try again in a bit." }, { status: 429 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { name, phone, reason, date, time, source } = body ?? {};
  if (typeof name !== "string" || !name.trim()) return NextResponse.json({ error: "name is required" }, { status: 400 });
  if (typeof phone !== "string" || !phone.trim()) return NextResponse.json({ error: "phone is required" }, { status: 400 });
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ error: "date must be YYYY-MM-DD" }, { status: 400 });
  if (typeof time !== "string" || !/^\d{2}:\d{2}$/.test(time)) return NextResponse.json({ error: "time must be HH:MM" }, { status: 400 });
  if (date < ymd(nowIST())) return NextResponse.json({ error: "That date has already passed" }, { status: 400 });

  try {
    const sched = await dbLoadSchedule();
    const taken = await dbTakenSlots(date);
    const open = slotsFor(new Date(`${date}T00:00:00`), taken, sched);
    if (!open.includes(time)) {
      return NextResponse.json({ error: "That time isn't available. Please pick another slot." }, { status: 400 });
    }

    const appt = await dbAddBooking({
      name,
      phone,
      reason: typeof reason === "string" ? reason : "",
      date,
      time,
      source: isSource(source) ? source : "website",
    });
    await sendBookingConfirmation(appt);
    return NextResponse.json({ appointment: appt }, { status: 201 });
  } catch (err) {
    if (err instanceof SlotTakenError) {
      return NextResponse.json({ error: "That slot was just taken. Please pick another." }, { status: 409 });
    }
    console.error("/api/book", err);
    return NextResponse.json({ error: "Could not create booking" }, { status: 500 });
  }
}
