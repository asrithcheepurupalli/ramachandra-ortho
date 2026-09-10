// Staff-only: records that a Razorpay refund was already issued manually from
// the Razorpay dashboard (clinic policy — see lib/refunds.ts). This route
// never calls Razorpay itself; it just writes the refund id + timestamp so
// the admin queue stops showing a cancelled-but-paid row as still owed and
// revenue rollups can subtract it.
import { NextResponse, type NextRequest } from "next/server";
import { requireStaff } from "@/lib/auth-server";
import { dbMarkRefunded } from "@/lib/db";
import { reportError } from "@/lib/bugdesk";

export async function POST(req: NextRequest) {
  if (!(await requireStaff())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { id, refundId } = body ?? {};
  if (typeof id !== "string" || !id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  if (typeof refundId !== "string" || !refundId.trim()) return NextResponse.json({ error: "refundId is required" }, { status: 400 });

  try {
    await dbMarkRefunded(id, refundId.trim());
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("/api/appointments/refund", err);
    await reportError("appointments/refund", err, { severity: "warning" });
    return NextResponse.json({ error: "Could not record refund" }, { status: 500 });
  }
}
