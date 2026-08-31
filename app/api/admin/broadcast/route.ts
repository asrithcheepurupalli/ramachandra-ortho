// Staff-only broadcast to today's active queue (running-late / closed-today
// notices). Sends a free-form WhatsApp text to each patient with a phone
// number — Meta only delivers these inside an active (patient-initiated,
// <24h) conversation and silently drops the rest, so this reaches whoever
// currently has an open conversation with the clinic's number.
import { NextResponse, type NextRequest } from "next/server";
import { requireStaff } from "@/lib/auth-server";
import { dbApptsForDate } from "@/lib/db";
import { sendText } from "@/lib/meta-whatsapp";
import { ymd } from "@/lib/schedule";
import { activeStatuses } from "@/lib/store";

export async function POST(req: NextRequest) {
  if (!(await requireStaff())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const message = typeof body?.message === "string" ? body.message.trim() : "";
  if (!message) return NextResponse.json({ error: "message is required" }, { status: 400 });

  try {
    const today = await dbApptsForDate(ymd(new Date()));
    const waiting = today.filter((a) => activeStatuses.includes(a.status) && a.status !== "consulting" && a.phone);

    const results = await Promise.allSettled(waiting.map((a) => sendText(a.phone, message)));
    const failed = results.filter((r) => r.status === "rejected").length;

    return NextResponse.json({ attempted: waiting.length, failed });
  } catch (err) {
    console.error("/api/admin/broadcast", err);
    return NextResponse.json({ error: "Could not send broadcast" }, { status: 500 });
  }
}
