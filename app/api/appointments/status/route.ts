// Staff-only appointment status change. Used by /admin instead of a direct
// client-side Supabase write so a status change can also trigger a WhatsApp
// notice (cancellation) via Meta's WhatsApp Cloud API — that send has to
// happen server-side, outside the 24h window a template is required.
import { NextResponse, type NextRequest } from "next/server";
import { requireStaff } from "@/lib/auth-server";
import { dbSetStatusReturning } from "@/lib/db";
import { sendBookingCancellation } from "@/lib/meta-whatsapp";
import type { ApptStatus } from "@/lib/store";

const validStatuses: ApptStatus[] = ["reserved", "confirmed", "waiting", "consulting", "done", "cancelled"];
const isStatus = (v: unknown): v is ApptStatus => typeof v === "string" && (validStatuses as string[]).includes(v);

export async function POST(req: NextRequest) {
  if (!(await requireStaff())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { id, status } = body ?? {};
  if (typeof id !== "string" || !id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  if (!isStatus(status)) return NextResponse.json({ error: "invalid status" }, { status: 400 });

  try {
    const appt = await dbSetStatusReturning(id, status);
    if (status === "cancelled") await sendBookingCancellation(appt);
    return NextResponse.json({ appointment: appt });
  } catch (err) {
    console.error("/api/appointments/status", err);
    return NextResponse.json({ error: "Could not update status" }, { status: 500 });
  }
}
