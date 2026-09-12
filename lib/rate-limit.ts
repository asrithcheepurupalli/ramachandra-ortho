// DB-backed rate limiter shared across serverless instances. The prior
// approach on /api/book (and the old /api/patients/lookup) was an in-memory
// Map — reset on every cold start and never shared between concurrent
// instances, so it only ever throttled a single warm instance. That's not a
// real limit against a distributed or sustained attempt: brute-forcing a
// booking endpoint only needs requests spread across a couple of instances to
// sail past it.
//
// This trades perfect atomicity for simplicity: two concurrent requests can
// both read the same counter before either writes, so a burst can land a
// couple of requests over the limit. That's normal for a throttle (not a hard
// security boundary) and fine here — the goal is raising the cost of
// brute-forcing, not a precise cap.
import { supabaseAdmin } from "@/lib/supabase-admin";

export async function isRateLimited(key: string, limit: number, windowMs: number): Promise<boolean> {
  const db = supabaseAdmin();
  const nowMs = Date.now();

  const { data: row, error: readErr } = await db
    .from("rate_limits")
    .select("count, window_start")
    .eq("key", key)
    .maybeSingle();
  if (readErr) {
    // Fail open on infra trouble — a broken limiter shouldn't take down
    // booking or lookup for every patient.
    console.error("rate-limit: read failed, allowing request", readErr);
    return false;
  }

  const windowExpired = !row || nowMs - new Date(row.window_start).getTime() > windowMs;
  if (windowExpired) {
    const { error } = await db
      .from("rate_limits")
      .upsert({ key, count: 1, window_start: new Date(nowMs).toISOString() }, { onConflict: "key" });
    if (error) console.error("rate-limit: reset write failed", error);
    return false;
  }

  const nextCount = row.count + 1;
  const { error } = await db.from("rate_limits").update({ count: nextCount }).eq("key", key);
  if (error) console.error("rate-limit: increment failed", error);
  return nextCount > limit;
}
