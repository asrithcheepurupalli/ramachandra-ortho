// Staff-only broadcast to a chosen day's queue (today's waiting patients, or a
// next-session reminder). The client picks which appointments to message; this
// route re-validates every id against that day's rows (active status + a phone
// on file) before sending, so a stale or hand-typed id can't reach a stranger.
// Sends the ortho_clinic_notice template (2 params: name, message) — a
// template, not free-form text, so it reaches everyone in the queue, not just
// patients with an active (<24h) WhatsApp conversation open.
import { NextResponse, type NextRequest } from "next/server";
import { requireStaff } from "@/lib/auth-server";
import { dbApptsForDate } from "@/lib/db";
import { sendClinicNotice } from "@/lib/meta-whatsapp";
import { ymd, nowIST } from "@/lib/schedule";

// The states a patient can still be messaged about. Consulting are in the room
// with the doctor; done/cancelled are gone.
const BROADCASTABLE = new Set(["reserved", "confirmed", "waiting"]);

const MAX_MSG = 400; // Meta body-parameter limit; keep notices short anyway

export async function POST(req: NextRequest) {
  if (!(await requireStaff())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const date = typeof body?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date)
    ? body.date
    : ymd(nowIST());
  const ids: unknown[] = Array.isArray(body?.ids) ? body.ids.filter((v: unknown) => typeof v === "string") : [];
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  if (!ids.length) return NextResponse.json({ error: "No recipients selected" }, { status: 400 });
  if (!message) return NextResponse.json({ error: "message is required" }, { status: 400 });
  if (message.length > MAX_MSG) return NextResponse.json({ error: `Message is too long (limit ${MAX_MSG} characters)` }, { status: 400 });

  try {
    const day = await dbApptsForDate(date);
    const targets = day.filter((a) => ids.includes(a.id) && BROADCASTABLE.has(a.status) && a.phone);
    if (!targets.length) {
      return NextResponse.json({ error: "None of the selected patients are messageable in that day's queue" }, { status: 400 });
    }

    const recipients = await Promise.all(
      targets.map(async (a) => {
        const ok = await sendClinicNotice(a.phone, a.name, message);
        return { id: a.id, name: a.name, ok };
      })
    );
    const failed = recipients.filter((r) => !r.ok).length;

    return NextResponse.json({ attempted: recipients.length, failed, recipients });
  } catch (err) {
    console.error("/api/admin/broadcast", err);
    return NextResponse.json({ error: "Could not send broadcast" }, { status: 500 });
  }
}