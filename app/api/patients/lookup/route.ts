import { NextResponse, type NextRequest } from "next/server";
import { dbLookupPatient } from "@/lib/db";

const RATE_LIMIT = 8;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const recentHits = new Map<string, number[]>();
function isRateLimited(key: string): boolean {
  const now = Date.now();
  const hits = (recentHits.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  hits.push(now);
  recentHits.set(key, hits);
  return hits.length > RATE_LIMIT;
}

export async function POST(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (isRateLimited(ip)) return NextResponse.json({ error: "Too many requests." }, { status: 429 });

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  const { query } = body ?? {};
  if (typeof query !== "string" || !query.trim()) return NextResponse.json({ error: "query is required" }, { status: 400 });

  try {
    const patient = await dbLookupPatient(query.trim());
    if (!patient) return NextResponse.json({ found: false });
    return NextResponse.json({ found: true, patient });
  } catch (err) {
    console.error("/api/patients/lookup", err);
    return NextResponse.json({ error: "Lookup failed." }, { status: 500 });
  }
}
