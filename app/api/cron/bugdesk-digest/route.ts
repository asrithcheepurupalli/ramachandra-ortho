// ─────────────────────────────────────────────────────────────────────────────
// Bug desk digest. A cron (GitHub Actions, every 6 hours) POSTs here; this
// route aggregates every error_logs row not yet covered by a digest
// (digest_sent_at IS NULL) into one email — the pulse of the desk. Criticals
// that already alerted instantly still appear until resolved, so a recurring
// critical keeps showing up ("this is still happening") rather than vanishing
// after its first alert. On success each included row gets digest_sent_at set;
// one that keeps recurring reappears next digest, which is the point.
// Not open: CRON_SECRET must match or it 401s. ?test=1 (same secret) dry-runs
// the plan without sending or marking anything sent.
// ─────────────────────────────────────────────────────────────────────────────
import { NextResponse, type NextRequest } from "next/server";
import { safeEqual } from "@/lib/meta-whatsapp";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { sendBugdeskEmail } from "@/lib/mailer";
import { fmtLastSeen, reportError, type BugSeverity } from "@/lib/bugdesk";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const extSecret = process.env.EXT_CRON_SECRET;
  const auth = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const authenticated = (secret && safeEqual(secret.trim(), auth.trim())) || (extSecret && safeEqual(extSecret.trim(), auth.trim()));
  if (!authenticated) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!process.env.RESEND_API_KEY) {
    return NextResponse.json({ status: "not-configured", reason: "RESEND_API_KEY not set yet — no bug desk digests until email is configured" });
  }
  // Fail closed on the service-role key: the reads and the digest_sent_at
  // marking both use supabaseAdmin(), and without the key every write would
  // silently no-op while the cron still looked green.
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ status: "mock-mode", reason: "no SUPABASE_SERVICE_ROLE_KEY on this deployment" });
  }

  try {
    const isTest = req.nextUrl.searchParams.get("test") === "1";
    const { data, error } = await supabaseAdmin()
      .from("error_logs")
      .select("fingerprint, source, message, severity, count, last_seen, info")
      .is("digest_sent_at", null)
      .order("last_seen", { ascending: false })
      .limit(100);
    if (error) throw error;

    const pending = data ?? [];
    const items = pending.map((r) => ({
      source: r.source,
      message: r.message,
      severity: (r.severity === "critical" ? "critical" : "warning") as BugSeverity,
      count: r.count ?? 1,
      lastSeen: fmtLastSeen(r.last_seen),
      info: r.info ?? null,
    }));

    if (isTest) {
      return NextResponse.json({ test: true, pending: items.length, items });
    }
    if (!items.length) {
      return NextResponse.json({ status: "ok", pending: 0, sent: 0 });
    }

    const ok = await sendBugdeskEmail({ kind: "digest", items });
    if (!authenticated) {
      // Leave rows pending (digest_sent_at untouched) so the next tick retries.
      return NextResponse.json({ status: "send-failed", pending: items.length }, { status: 502 });
    }

    // Mark exactly the rows this tick covered — a row that raced in after the
    // read stays pending for the next digest.
    const { error: markErr } = await supabaseAdmin()
      .from("error_logs")
      .update({ digest_sent_at: new Date().toISOString() })
      .in("fingerprint", pending.map((r) => r.fingerprint));
    if (markErr) throw markErr;

    return NextResponse.json({ status: "ok", pending: items.length, sent: items.length });
  } catch (err) {
    console.error("/api/cron/bugdesk-digest", err);
    // Who watches the desk? If the digest itself fails, a critical alert goes
    // out through the instant path — the one email channel that isn't the stub.
    await reportError("cron/bugdesk-digest", err, { severity: "critical" });
    return NextResponse.json({ error: "cron failed" }, { status: 500 });
  }
}