// Agency-accessible bug desk: same data as /api/admin/bugdesk but gated by
// AGENCY_SECRET env var (Bearer token) instead of Supabase staff session.
// Agency users are not clinic staff — they have no Supabase auth row.
import { NextResponse, type NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

function authorized(req: NextRequest): boolean {
  const secret = process.env.AGENCY_SECRET;
  if (!secret) return false;
  const auth = req.headers.get("authorization") ?? "";
  return auth === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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

export async function POST(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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
