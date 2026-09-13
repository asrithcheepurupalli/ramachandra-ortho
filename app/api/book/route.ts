// Creates a booking. The single place token assignment + patient dedupe
// happen, so every booking source (website today) goes through it.
import { NextResponse, type NextRequest } from "next/server";
import { dbAddBooking, dbLoadSchedule } from "@/lib/db";
import { SlotTakenError, PendingHoldError, DuplicateSlotError } from "@/lib/errors";
import { allSlotsFor, ymd, nowIST } from "@/lib/schedule";
import { normalizePhone, isValidIndianMobile } from "@/lib/phone";
import { isRateLimited } from "@/lib/rate-limit";
import { reportError } from "@/lib/bugdesk";
import { sendNewAppointmentEmail } from "@/lib/mailer";

type Source = "website" | "whatsapp" | "walkin";
const isSource = (v: unknown): v is Source => v === "website" || v === "whatsapp" || v === "walkin";
type Claim = "returning_unverified" | "review_free";
const isClaim = (v: unknown): v is Claim => v === "returning_unverified" || v === "review_free";
const isGender = (v: unknown): v is "M" | "F" => v === "M" || v === "F";

const RATE_LIMIT = 40;
const RATE_WINDOW_MS = 10 * 60 * 1000;

export async function POST(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (await isRateLimited(`book:${ip}`, RATE_LIMIT, RATE_WINDOW_MS)) {
    return NextResponse.json({ error: "Too many requests. Please try again in a bit." }, { status: 429 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { name, phone, age, gender, date, time, source, replacePending, claim } = body ?? {};
  if (typeof name !== "string" || !name.trim()) return NextResponse.json({ error: "name is required" }, { status: 400 });
  if (typeof phone !== "string" || !phone.trim()) return NextResponse.json({ error: "phone is required" }, { status: 400 });
  if (!isValidIndianMobile(normalizePhone(phone))) return NextResponse.json({ error: "phone must be a valid 10-digit mobile number" }, { status: 400 });
  if (typeof age !== "number" || age < 0 || age > 150) return NextResponse.json({ error: "age is required" }, { status: 400 });
  // The website form requires gender; the WhatsApp bot never asks, so it's
  // optional here and just stored as null when omitted.
  if (gender != null && !isGender(gender)) return NextResponse.json({ error: "gender must be M or F" }, { status: 400 });
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ error: "date must be YYYY-MM-DD" }, { status: 400 });
  if (typeof time !== "string" || !/^\d{2}:\d{2}$/.test(time)) return NextResponse.json({ error: "time must be HH:MM" }, { status: 400 });
  if (date < ymd(nowIST())) return NextResponse.json({ error: "That date has already passed" }, { status: 400 });

  try {
    const sched = await dbLoadSchedule();
    const open = allSlotsFor(new Date(`${date}T00:00:00`), sched);
    if (!open.includes(time)) {
      return NextResponse.json({ error: "That time isn't available. Please pick another slot." }, { status: 400 });
    }

    const appt = await dbAddBooking({
      name,
      phone,
      age,
      gender: isGender(gender) ? gender : null,
      date,
      time,
      source: isSource(source) ? source : "website",
      replacePending: replacePending === true,
      claim: isClaim(claim) ? claim : undefined,
    });
    // No confirmation template here. A new booking sits in payment_pending for
    // the payment window, so nothing may say "confirmed" yet — the number arrives
    // on the screen with the pay banner, and the real confirmation goes out as
    // META_TEMPLATE_PAID once the Razorpay webhook flips it to reserved.
    //
    // A claimed booking skips payment_pending and Razorpay entirely, so it
    // never reaches the webhook that would otherwise fire this — send it here.
    if (appt.claimType) {
      const ok = await sendNewAppointmentEmail(appt);
      if (!ok) await reportError("book", new Error("claim email notify failed"), { severity: "warning", info: { channel: "email", appt: appt.id } });
    }
    return NextResponse.json({ appointment: appt }, { status: 201 });
  } catch (err) {
    if (err instanceof PendingHoldError) {
      return NextResponse.json({
        error: "You already have a booking waiting for payment. Please complete that payment first to confirm your slot (an unpaid booking is released automatically after 15 minutes).",
        code: "pending_hold",
      }, { status: 409 });
    }
    if (err instanceof DuplicateSlotError) {
      return NextResponse.json({
        error: "You already have an appointment at that date and time. To book a different slot, cancel the existing one first.",
        code: "duplicate_slot",
      }, { status: 409 });
    }
    if (err instanceof SlotTakenError) {
      return NextResponse.json({ error: "That slot was just taken. Please pick another." }, { status: 409 });
    }
    console.error("/api/book", err);
    await reportError("book", err, { severity: "critical" });
    return NextResponse.json({ error: "Could not create booking" }, { status: 500 });
  }
}
