// Creates a booking. The single place token assignment + patient dedupe
// happen, so every booking source (website today) goes through it.
import { NextResponse, type NextRequest } from "next/server";
import { dbAddBooking } from "@/lib/db";
import { sendBookingConfirmation } from "@/lib/meta-whatsapp";

type Source = "website" | "whatsapp" | "walkin";
const isSource = (v: unknown): v is Source => v === "website" || v === "whatsapp" || v === "walkin";

export async function POST(req: NextRequest) {
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

  try {
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
    console.error("/api/book", err);
    return NextResponse.json({ error: "Could not create booking" }, { status: 500 });
  }
}
