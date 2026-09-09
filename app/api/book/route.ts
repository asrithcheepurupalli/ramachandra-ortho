// Creates a booking. The single place token assignment + patient dedupe
// happen, so every booking source (website today) goes through it.
import { NextResponse, type NextRequest } from "next/server";
import { dbAddBooking, dbLoadSchedule, dbTakenSlots } from "@/lib/db";
import { SlotTakenError, PendingHoldError } from "@/lib/errors";
import { slotsFor, ymd, nowIST } from "@/lib/schedule";
import { normalizePhone } from "@/lib/phone";
import { isRateLimited } from "@/lib/rate-limit";

type Source = "website" | "whatsapp" | "walkin";
const isSource = (v: unknown): v is Source => v === "website" || v === "whatsapp" || v === "walkin";

const RATE_LIMIT = 40;
const RATE_WINDOW_MS = 10 * 60 * 1000;

export async function POST(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (await isRateLimited(`book:${ip}`, RATE_LIMIT, RATE_WINDOW_MS)) {
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
  if (normalizePhone(phone).length !== 10) return NextResponse.json({ error: "phone must be a valid 10-digit number" }, { status: 400 });
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
    // No confirmation template here. A new booking sits in payment_pending for
    // the payment window, so nothing may say "confirmed" yet — the number arrives
    // on the screen with the pay banner, and the real confirmation goes out as
    // META_TEMPLATE_PAID once the Razorpay webhook flips it to reserved.
    return NextResponse.json({ appointment: appt }, { status: 201 });
  } catch (err) {
    if (err instanceof PendingHoldError) {
      return NextResponse.json({
        error: "You already have a booking waiting for payment. Please complete that payment first to confirm your slot (an unpaid booking is released automatically after 30 minutes).",
        code: "pending_hold",
      }, { status: 409 });
    }
    if (err instanceof SlotTakenError) {
      return NextResponse.json({ error: "That slot was just taken. Please pick another." }, { status: 409 });
    }
    console.error("/api/book", err);
    return NextResponse.json({ error: "Could not create booking" }, { status: 500 });
  }
}
