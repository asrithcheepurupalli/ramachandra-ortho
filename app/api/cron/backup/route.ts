// ─────────────────────────────────────────────────────────────────────────────
// Daily DB backup. A cron (GitHub Actions, once a day) POSTs here; this route
// dumps patients + appointments as JSON and emails it as an attachment to the
// clinic's own inbox. Same CRON_SECRET gate and fail-closed shape as the bug
// desk digest cron. ?test=1 (same secret) dry-runs and returns row counts
// without sending anything.
// ─────────────────────────────────────────────────────────────────────────────
import { NextResponse, type NextRequest } from "next/server";
import { safeEqual } from "@/lib/meta-whatsapp";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { sendBackupEmail } from "@/lib/mailer";
import { reportError } from "@/lib/bugdesk";
import { ymd, nowIST } from "@/lib/schedule";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET ?? process.env.EXT_CRON_SECRET;
  const auth = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!secret || !auth || !safeEqual(secret.trim(), auth.trim())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!process.env.RESEND_API_KEY) {
    return NextResponse.json({ status: "not-configured", reason: "RESEND_API_KEY not set yet — no backup emails until email is configured" });
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ status: "mock-mode", reason: "no SUPABASE_SERVICE_ROLE_KEY on this deployment" });
  }

  try {
    const isTest = req.nextUrl.searchParams.get("test") === "1";
    const dateLabel = ymd(nowIST());

    const [{ data: patients, error: patientsErr }, { data: appointments, error: apptErr }] = await Promise.all([
      supabaseAdmin().from("patients").select("*"),
      supabaseAdmin().from("appointments").select("*"),
    ]);
    if (patientsErr) throw patientsErr;
    if (apptErr) throw apptErr;

    if (isTest) {
      return NextResponse.json({ test: true, patients: patients?.length ?? 0, appointments: appointments?.length ?? 0 });
    }

    const dump = JSON.stringify({ generatedAt: new Date().toISOString(), patients, appointments });
    const ok = await sendBackupEmail(dump, dateLabel);
    if (!ok) {
      await reportError("cron/backup", new Error("backup email failed to send"), { severity: "critical" });
      return NextResponse.json({ status: "send-failed" }, { status: 502 });
    }

    return NextResponse.json({ status: "ok", patients: patients?.length ?? 0, appointments: appointments?.length ?? 0 });
  } catch (err) {
    console.error("/api/cron/backup", err);
    await reportError("cron/backup", err, { severity: "critical" });
    return NextResponse.json({ error: "cron failed" }, { status: 500 });
  }
}
