// ─────────────────────────────────────────────────────────────────────────────
// Payment timeout for mandatory-online-payment bookings. New bookings start as
// payment_pending with their slot held for 30 minutes (the Razorpay payment
// link carries the same 30-minute expire_by). A patient who never pays leaves
// the slot locked forever, so a cron POSTs here every 5 minutes and cancels any
// payment_pending row older than 30 minutes, freeing its slot for someone else.
//
// No WhatsApp cancellation notice is sent: the patient never had a confirmed
// appointment (the row was never shown as active anywhere), and a "your slot
// was released" nudge would only add noise. No refund logic — nothing was paid.
//
// Idempotent by nature: each tick only touches rows that are still
// payment_pending, so a retried or overlapping tick finds nothing to do.
// CRON_SECRET-gated like the other cron routes — without a matching secret the
// call 401s.
// ─────────────────────────────────────────────────────────────────────────────
import { NextResponse, type NextRequest } from "next/server";
import { safeEqual } from "@/lib/meta-whatsapp";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

const PAYMENT_WINDOW_MS = 30 * 60 * 1000;

export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
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
    .select("id, token, name, appt_date, appt_time")
    .eq("status", "payment_pending")
    .lt("created_at", cutoff);

  if (readErr) {
    console.error("/api/cron/payment-timeout: read failed", readErr);
    return NextResponse.json({ error: "read failed" }, { status: 500 });
  }

  const cancelled: string[] = [];
  for (const row of stale ?? []) {
    const { data, error: writeErr } = await supabaseAdmin()
      .from("appointments")
      .update({ status: "cancelled" })
      .eq("id", row.id)
      .eq("status", "payment_pending") // guard: never clobber a row the webhook just reserved
      .eq("paid", false)               // guard: never cancel a row the desk collected cash for
      .select("id");
    if (writeErr) {
      console.error(`/api/cron/payment-timeout: cancel ${row.id} failed`, writeErr);
    } else if (data?.length) {
      // A guard above can still win the race (the Razorpay webhook reserved the
      // row between our read and this write), in which case the UPDATE matched
      // zero rows and data is empty — that's not a cancellation, so don't report
      // it as one.
      cancelled.push(row.id);
    }
  }

  return NextResponse.json({ status: "ok", windowMinutes: 30, cancelled });
}