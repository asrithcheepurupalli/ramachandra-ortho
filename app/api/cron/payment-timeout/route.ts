// ─────────────────────────────────────────────────────────────────────────────
// Payment timeout for mandatory-online-payment bookings. New bookings start as
// payment_pending with their slot held for 15 minutes (the Razorpay payment
// link carries the same 15-minute expire_by). A patient who never pays leaves
// the slot locked forever, so a cron POSTs here every 5 minutes and cancels any
// payment_pending row older than 15 minutes, freeing its slot for someone else.
//
// After cancelling, WhatsApp-source holds get ONE follow-up nudge (offered
// within Meta's 24h customer window): a "New payment link" button that revives
// the same booking with a fresh Razorpay link for the same slot, or "Change
// booking" to start over. No refund logic — nothing was paid.
//
// Idempotent by nature: each tick only touches rows that are still
// payment_pending, so a retried or overlapping tick finds nothing to do.
// CRON_SECRET-gated like the other cron routes — without a matching secret the
// call 401s.
// ─────────────────────────────────────────────────────────────────────────────
import { NextResponse, type NextRequest } from "next/server";
import { safeEqual } from "@/lib/meta-whatsapp";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { report, reportError } from "@/lib/bugdesk";
import { PAYMENT_WINDOW_MS } from "@/lib/db";
import { sendButtons } from "@/lib/meta-whatsapp";
import { RESUME_PAY_CHIPS } from "@/lib/bot";

export const dynamic = "force-dynamic";

// The one-time post-expiry nudge body, offered to WhatsApp patients whose
// payment link lapsed. Both chip labels stay under Meta's 20-char button cap.
const NUDGE_BODY = "Your payment link expired, so your slot was released. Tap below to pay for the same time with a fresh link, or change your booking.";

export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET ?? process.env.EXT_CRON_SECRET;
  const auth = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!secret || !auth || !safeEqual(secret.trim(), auth.trim())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // Gate on the SERVICE-ROLE key, not hasSupabase(): the writes below use
  // supabaseAdmin(), and if the admin key is missing every write silently
  // fails while hasSupabase() (URL + anon key) still reports ready — a green
  // cron that never actually expires anything. Failing closed on the real key
  // keeps the CI run honest.
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ status: "mock-mode", reason: "no SUPABASE_SERVICE_ROLE_KEY on this deployment" });
  }

  const cutoff = new Date(Date.now() - PAYMENT_WINDOW_MS).toISOString();

  const { data: stale, error: readErr } = await supabaseAdmin()
    .from("appointments")
    .select("id, token, name, appt_date, appt_time, phone, source")
    .eq("status", "payment_pending")
    .lt("created_at", cutoff);

  if (readErr) {
    console.error("/api/cron/payment-timeout: read failed", readErr);
    // The cron can't see pending payments, so expired holds never free up —
    // slots stay locked. Escalate now, not in the next digest.
    await reportError("cron/payment-timeout", readErr, { severity: "critical", info: { stage: "read" } });
    return NextResponse.json({ error: "read failed" }, { status: 500 });
  }

  const cancelled: string[] = [];
  for (const row of stale ?? []) {
    const { data, error: writeErr } = await supabaseAdmin()
      .from("appointments")
      .update({ status: "cancelled", cancel_reason: "payment_timeout" })
      .eq("id", row.id)
      .eq("status", "payment_pending") // guard: never clobber a row the webhook just reserved
      .eq("paid", false)               // guard: never cancel a row the desk collected cash for
      .select("id");
    if (writeErr) {
      console.error(`/api/cron/payment-timeout: cancel ${row.id} failed`, writeErr);
      await reportError("cron/payment-timeout", writeErr, { severity: "critical", info: { stage: "cancel", id: row.id } });
    } else if (data?.length) {
      // A guard above can still win the race (the Razorpay webhook reserved the
      // row between our read and this write), in which case the UPDATE matched
      // zero rows and data is empty — that's not a cancellation, so don't report
      // it as one.
      cancelled.push(row.id);
    }
  }

  // ── post-expiry re-nudge ──────────────────────────────────────────────────
  // WhatsApp patients whose link expired (row cancelled by this or an earlier
  // tick) get exactly one nudge. Mark-then-send with the same idempotency guard
  // as the reminder crons: only the row that wins the conditional update on
  // expired_payment_nudged_at being null sends; a failed send rolls the flag
  // back so the next tick (within 5 min) retries inside Meta's 24h window.
  // Bounded to the last 24h so a never-sent nudge is not retried forever. A row
  // revived meanwhile (status payment_pending) exits both the read and the
  // win-guard. Soft-gated on META_WHATSAPP_TOKEN: without it every send returns
  // false, which would spam Bedbug criticals on non-prod deployments.
  const nudged: string[] = [];
  if (process.env.META_WHATSAPP_TOKEN) {
    const { data: toNudge, error: nudgeErr } = await supabaseAdmin()
      .from("appointments")
      .select("id, phone")
      .eq("status", "cancelled")
      .eq("cancel_reason", "payment_timeout")
      .is("expired_payment_nudged_at", null)
      .eq("source", "whatsapp")
      .gt("created_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
      .not("phone", "is", null);

    if (nudgeErr) {
      await reportError("cron/payment-timeout", nudgeErr, { severity: "critical", info: { stage: "nudge_read" } });
    } else {
      const nowIso = new Date().toISOString();
      for (const row of toNudge ?? []) {
        const { data: claimed } = await supabaseAdmin()
          .from("appointments")
          .update({ expired_payment_nudged_at: nowIso })
          .eq("id", row.id)
          .eq("status", "cancelled")
          .is("expired_payment_nudged_at", null)
          .select("id");
        if (!claimed?.length) continue; // another tick already nudged, or the row was revived
        const rollback = async () => { await supabaseAdmin().from("appointments").update({ expired_payment_nudged_at: null }).eq("id", row.id).eq("status", "cancelled"); };
        try {
          const sent = await sendButtons(row.phone, NUDGE_BODY, [RESUME_PAY_CHIPS.link, RESUME_PAY_CHIPS.change]);
          if (sent) {
            nudged.push(row.id);
          } else {
            await rollback();
            await reportError("cron/payment-timeout", new Error("nudge send failed"), { severity: "critical", info: { stage: "nudge_send", id: row.id } });
          }
        } catch (err) {
          await rollback();
          await reportError("cron/payment-timeout", err, { severity: "critical", info: { stage: "nudge_send", id: row.id } });
        }
      }
    }
  }

  return NextResponse.json({ status: "ok", windowMinutes: 15, cancelled, nudged });
}