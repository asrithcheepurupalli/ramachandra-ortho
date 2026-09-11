// Staff-only bug desk: read the error log, mark issues resolved/reopened.
// The error_logs table is RLS-deny-all (service-role only), so staff reach it
// here through the same requireStaff() gate every /admin route uses, never
// directly from the client.
import { NextResponse, type NextRequest } from "next/server";
import { requireStaff } from "@/lib/auth-server";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

// Latest 100 issues, newest first.
export async function GET() {
  if (!(await requireStaff())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ status: "mock-mode", rows: [] });
  }

  const { data, error } = await supabaseAdmin()
    .from("error_logs")
    .select("fingerprint, source, message, severity, count, first_seen, last_seen, alerted_at, resolved")
    .order("last_seen", { ascending: false })
    .limit(100);
  if (error) return NextResponse.json({ error: "Could not load bug desk" }, { status: 500 });

  return NextResponse.json({ rows: data ?? [] });
}

// Toggle resolve/reopen: { fingerprint, resolved: true | false }
export async function POST(req: NextRequest) {
  if (!(await requireStaff())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: "mock-mode: nothing to resolve" }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  const { fingerprint, resolved } = body ?? {};
  if (typeof fingerprint !== "string" || !fingerprint.trim()) {
    return NextResponse.json({ error: "fingerprint is required" }, { status: 400 });
  }

  const { error } = await supabaseAdmin()
    .from("error_logs")
    .update({ resolved: resolved === true })
    .eq("fingerprint", fingerprint);
  if (error) return NextResponse.json({ error: "Could not update" }, { status: 500 });

  return NextResponse.json({ ok: true });
}