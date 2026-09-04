// Staff-only broadcast to today's active queue (running-late / closed-today
// notices). Sends the ortho_clinic_notice template to each patient with a
// phone number — a template (not free-form text) so this reaches everyone
// in the queue, not just whoever happens to have an active (<24h) WhatsApp
// conversation open, since most patients book via the website and never
// message the clinic's number at all.
import { NextResponse, type NextRequest } from "next/server";
import { requireStaff } from "@/lib/auth-server";
import { dbApptsForDate } from "@/lib/db";
import { sendClinicNotice } from "@/lib/meta-whatsapp";
import { ymd, nowIST } from "@/lib/schedule";
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
    const today = await dbApptsForDate(ymd(nowIST()));
    const waiting = today.filter((a) => activeStatuses.includes(a.status) && a.status !== "consulting" && a.phone);

    const results = await Promise.allSettled(waiting.map((a) => sendClinicNotice(a.phone, a.name, message)));
    const failed = results.filter((r) => r.status === "rejected" || !r.value).length;

    return NextResponse.json({ attempted: waiting.length, failed });
  } catch (err) {
    console.error("/api/admin/broadcast", err);
    return NextResponse.json({ error: "Could not send broadcast" }, { status: 500 });
  }
}
