// Bug-desk ingestion: the bridge between the WhatsApp webhook process (which
// bundles the bot engine for both server AND browser, so it cannot statically
// import the server-only bugdesk module) and the desk itself. The bot's
// reportBotError does a self-fetch to this route when running server-side.
// Public by design, but IP-rate-limited so junk from a single address tops
// out at 60 reports/hour — worst case is a few junk rows in error_logs,
// visible to staff, never a storm.
import { NextResponse, type NextRequest } from "next/server";
import { report } from "@/lib/bugdesk";
import { isRateLimited } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (await isRateLimited(`bugdesk:ingest:${ip}`, 60, 60 * 60 * 1000)) {
    return NextResponse.json({ error: "Too many reports" }, { status: 429 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { source, message, severity, info } = body ?? {};
  if (typeof source !== "string" || !source.trim()) return NextResponse.json({ error: "source is required" }, { status: 400 });
  if (typeof message !== "string" || !message.trim()) return NextResponse.json({ error: "message is required" }, { status: 400 });

  await report({
    source,
    message,
    severity: severity === "critical" ? "critical" : "warning",
    info: info && typeof info === "object" ? info : undefined,
  });

  return NextResponse.json({ ok: true }, { status: 200 });
}