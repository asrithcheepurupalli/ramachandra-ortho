import { NextResponse, type NextRequest } from "next/server";
import { dbLookupPatient } from "@/lib/db";
import { isRateLimited } from "@/lib/rate-limit";
import { reportError } from "@/lib/bugdesk";

// This is the endpoint that makes patient enumeration possible: it's public,
// unauthenticated, and returns a real name given a guessed phone number or
// patient code. Two windows, both DB-backed (shared across instances, unlike
// the old in-memory Map) — a short burst cap for casual abuse, and a much
// lower daily cap per IP so a slow, cold-start-spread guessing attempt still
// gets bounded instead of resetting itself for free every few requests.
const BURST_LIMIT = 8;
const BURST_WINDOW_MS = 10 * 60 * 1000;
const DAILY_LIMIT = 30;
const DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;
// Global cap across all IPs — bounds distributed enumeration even when each
// attacker stays under the per-IP limits. Blunt but effective for a throttle.
const GLOBAL_LIMIT = 200;
const GLOBAL_WINDOW_MS = 60 * 60 * 1000;

export async function POST(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const [burstLimited, dailyLimited, globalLimited] = await Promise.all([
    isRateLimited(`lookup:burst:${ip}`, BURST_LIMIT, BURST_WINDOW_MS),
    isRateLimited(`lookup:daily:${ip}`, DAILY_LIMIT, DAILY_WINDOW_MS),
    isRateLimited("lookup:global", GLOBAL_LIMIT, GLOBAL_WINDOW_MS),
  ]);
  if (burstLimited || dailyLimited || globalLimited) return NextResponse.json({ error: "Too many requests." }, { status: 429 });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  const { query } = body ?? {};
  if (typeof query !== "string" || !query.trim()) return NextResponse.json({ error: "query is required" }, { status: 400 });

  try {
    const patient = await dbLookupPatient(query.trim());
    if (!patient) return NextResponse.json({ found: false });
    return NextResponse.json({ found: true, patient });
  } catch (err) {
    console.error("/api/patients/lookup", err);
    await reportError("patients/lookup", err, { severity: "warning" });
    return NextResponse.json({ error: "Lookup failed." }, { status: 500 });
  }
}
