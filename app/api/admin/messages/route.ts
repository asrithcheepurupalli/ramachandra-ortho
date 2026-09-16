import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-server";
import { dbGetWhatsAppLogs } from "@/lib/db";
import { reportError } from "@/lib/bugdesk";

export async function GET(req: Request) {
  if (!(await requireStaff())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(req.url);
    const limitParam = searchParams.get("limit");
    const limit = limitParam ? Math.min(Math.max(parseInt(limitParam, 10) || 100, 1), 500) : 100;

    const logs = await dbGetWhatsAppLogs(limit);
    return NextResponse.json({ logs });
  } catch (err) {
    console.error("/api/admin/messages GET", err);
    await reportError("admin/messages", err, { severity: "warning" });
    return NextResponse.json({ error: "Failed to fetch whatsapp logs" }, { status: 500 });
  }
}
