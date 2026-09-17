"use client";
// ─────────────────────────────────────────────────────────────────────────────
// Client-side Supabase data access for /admin (authenticated staff session,
// RLS-governed — not service-role). Mirrors lib/store.ts's shapes/logic so
// components can swap one hook/call for another without branching on shape.
// Never import lib/db.ts (service-role) into client-bundled code — this file
// is the DB-mode counterpart that's safe to ship to the browser.
// ─────────────────────────────────────────────────────────────────────────────
import { useEffect, useState, useSyncExternalStore } from "react";
import { supabaseBrowser, hasSupabase } from "@/lib/supabase";
import { clinic } from "@/clinic.config";
import {
  ymd, weeklyHours, exceptions, applySchedule, setOverride,
  onScheduleChange, notifyScheduleChange, defaultWeeklyHours,
  type WeeklyHours, type Exception, type Override, type SchedState,
} from "@/lib/schedule";
import { useAppts, type Appt, type ApptStatus, type Source } from "@/lib/store";
import { normalizePhone } from "@/lib/phone";

type DbApptRow = {
  id: string; token: number; name: string; phone: string | null; age: number | null;
  gender: "M" | "F" | null; appt_date: string; appt_time: string; status: string;
  source: string; fee: number; paid: boolean; paid_via: string | null;
  razorpay_payment_id: string | null; razorpay_refund_id: string | null;
  refunded_at: string | null; reminder_sent_at: string | null; created_at: string;
  notes: string | null; patient_code: string | null; claim_type: string | null;
  review_nudge_sent_at: string | null; free_visit_reminder_sent_at: string | null;
  cancel_reason: string | null; expired_payment_nudged_at: string | null;
  locality: string | null;
};
function rowToAppt(r: DbApptRow): Appt {
  return {
    id: r.id,
    token: r.token,
    name: r.name,
    phone: r.phone ?? "",
    age: r.age ?? 0,
    gender: r.gender ?? null,
    date: r.appt_date,
    time: r.appt_time,
    status: r.status as ApptStatus,
    source: r.source as Source,
    fee: r.fee,
    paid: r.paid,
    paidVia: r.paid_via as "razorpay" | "cash" | null,
    paymentId: r.razorpay_payment_id ?? null,
    refundId: r.razorpay_refund_id ?? null,
    refundedAt: r.refunded_at ? new Date(r.refunded_at).getTime() : null,
    reminderSentAt: r.reminder_sent_at ? new Date(r.reminder_sent_at).getTime() : null,
    reviewNudgeSentAt: r.review_nudge_sent_at ? new Date(r.review_nudge_sent_at).getTime() : null,
    freeVisitReminderSentAt: r.free_visit_reminder_sent_at ? new Date(r.free_visit_reminder_sent_at).getTime() : null,
    cancelReason: r.cancel_reason ?? null,
    expiredPaymentNudgedAt: r.expired_payment_nudged_at ? new Date(r.expired_payment_nudged_at).getTime() : null,
    createdAt: new Date(r.created_at).getTime(),
    notes: r.notes ?? null,
    patientCode: r.patient_code ?? null,
    claimType: r.claim_type as "returning_unverified" | "review_free" | null,
    paymentDeadlineAt: null,
    locality: r.locality ?? null,
  };
}

// ── live queue: full read + realtime subscription ───────────────────────────
// Realtime events patch the row they describe directly from the payload
// instead of re-querying the whole table — a full `select("*")` on every
// change was an extra network round trip (on top of the websocket delivery
// itself) that made every status/paid click feel laggy on a slow connection.
function useDbAppts(): [Appt[], (id: string, patch: Partial<Appt>) => void, boolean] {
  const [appts, setAppts] = useState<Appt[]>([]);
  const [loadError, setLoadError] = useState(false);
  useEffect(() => {
    if (!hasSupabase()) return;
    const db = supabaseBrowser();
    let cancelled = false;

    const load = async () => {
      // Unbounded select — fine at clinic scale (~dozens of rows/day, a few
      // thousand total). When the table grows past ~50k rows, add a
      // .gte("appt_date", startOfRollingWindow) filter and move historical
      // revenue queries to a server route with pagination.
      const { data, error } = await db.from("appointments").select("*");
      if (cancelled) return;
      if (error) { setLoadError(true); return; }
      setLoadError(false);
      setAppts((data ?? []).map(rowToAppt));
    };
    load();

    const channel = db
      .channel("appointments-admin")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "appointments" }, (payload) => {
        setAppts((prev) => (prev.some((a) => a.id === payload.new.id) ? prev : [...prev, rowToAppt(payload.new as DbApptRow)]));
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "appointments" }, (payload) => {
        setAppts((prev) => prev.map((a) => (a.id === payload.new.id ? rowToAppt(payload.new as DbApptRow) : a)));
      })
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "appointments" }, (payload) => {
        setAppts((prev) => prev.filter((a) => a.id !== payload.old.id));
      })
      .subscribe();

    // A desk tab can sit open all day. Realtime is the primary channel, but a
    // momentary websocket drop misses events (reconnect doesn't replay them),
    // so a slow re-fetch + a refetch on refocus act as a self-healing safety
    // net — the desk should never have to reload manually.
    const poll = window.setInterval(load, 45_000);
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);

    return () => {
      cancelled = true;
      window.clearInterval(poll);
      window.removeEventListener("focus", onFocus);
      db.removeChannel(channel);
    };
  }, []);

  // Lets a click handler reflect its own change immediately instead of
  // waiting on the round trip to Supabase and back through realtime — the
  // realtime patch above (or the next poll) reconciles shortly after, so a
  // stale optimistic value never lingers.
  const patchAppt = (id: string, patch: Partial<Appt>) => {
    setAppts((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  };

  return [appts, patchAppt, loadError];
}

// Unconditionally calls both hooks (hasSupabase() is a build-time constant,
// so this never violates the rules of hooks) and picks the active one. Mock
// mode's own store already writes + re-renders synchronously, so its patch
// function is a no-op — only DB mode needs the optimistic bridge.
export function useAdminAppts(): [Appt[], (id: string, patch: Partial<Appt>) => void, boolean] {
  const mock = useAppts();
  const [db, patchDb, loadError] = useDbAppts();
  return hasSupabase() ? [db, patchDb, loadError] : [mock, () => {}, false];
}

// ── walk-in / status / paid ──────────────────────────────────────────────────
export async function dbAddWalkIn(input: {
  name: string;
  phone: string;
  age: number;
  gender?: "M" | "F" | null;
  locality?: string | null;
  source?: Source;
}): Promise<Appt> {
  const db = supabaseBrowser();
  const today = ymd(new Date());
  const name = input.name.trim();
  const phone = normalizePhone(input.phone);

  let patientId: string | null = null;
  let patientCode: string | null = null;
  const fee: number = clinic.consultationFee;
  if (phone) {
    const { data: existing, error: existingErr } = await db
      .from("patients")
      .select("id, patient_code")
      .eq("phone", phone)
      .maybeSingle();
    if (existingErr) throw existingErr;
    if (existing) {
      // Known patient — keeps their code; same flat fee as everyone else.
      patientId = existing.id;
      patientCode = existing.patient_code ?? null;
    } else {
      const { data: patient, error: patientErr } = await db
        .from("patients")
        .upsert({ name, phone }, { onConflict: "phone" })
        .select("id, patient_code")
        .single();
      if (patientErr) throw patientErr;
      patientId = patient?.id ?? null;
      patientCode = patient?.patient_code ?? null;
    }
  }

  const { data: dayAppts, error: dayErr } = await db.from("appointments").select("token").eq("appt_date", today);
  if (dayErr) throw dayErr;
  const token = (dayAppts ?? []).reduce((m, a) => Math.max(m, a.token as number), 0) + 1;

  const { data: row, error } = await db
    .from("appointments")
    .insert({
      token,
      patient_id: patientId,
      patient_code: patientCode,
      name,
      phone,
      age: input.age,
      gender: input.gender ?? null,
      locality: input.locality ?? null,
      reason: "Consultation",
      appt_date: today,
      appt_time: new Date().toTimeString().slice(0, 5),
      status: "waiting",
      source: input.source ?? "walkin",
      fee,
      paid: false,
    })
    .select("*")
    .single();
  if (error) throw error;
  return rowToAppt(row);
}

export async function dbTogglePaidClient(id: string, currentPaid: boolean): Promise<void> {
  const db = supabaseBrowser();
  // A desk toggle always represents cash collected at the clinic, and must
  // never undo a Razorpay collection — the money has already moved; refunds
  // are the only reversal. The read and the write are both conditional so a
  // payment webhook landing between them can't be clobbered either.
  const { data: row } = await db.from("appointments").select("paid, paid_via, status").eq("id", id).maybeSingle();
  if (row && row.paid_via === "razorpay") return;

  const update: Record<string, unknown> = { paid: !currentPaid };
  if (!currentPaid) {
    update.paid_via = "cash";
    // Cash-settling a payment_pending hold promotes it to reserved (mirrors
    // the mock togglePaid) so the confirmed row appears in the queue — and so
    // the payment-timeout cron can't later cancel a row the desk took cash for.
    if (row?.status === "payment_pending") update.status = "reserved";
  } else {
    update.paid_via = null;                      // undoing a cash payment
  }
  let q = db.from("appointments").update(update).eq("id", id);
  q = currentPaid ? q.eq("paid", true).eq("paid_via", "cash") : q.eq("paid", false);
  const { error } = await q;
  if (error) throw error;
}

// Doctor's clinical note on an appointment — plain field write, no side
// effects to trigger server-side, so (like dbTogglePaidClient) this goes
// straight to PostgREST rather than through an API route.
export async function dbSetNotes(id: string, notes: string): Promise<void> {
  const { error } = await supabaseBrowser().from("appointments").update({ notes: notes.trim() || null }).eq("id", id);
  if (error) throw error;
}

// ── schedule ──────────────────────────────────────────────────────────────────
export async function dbLoadScheduleClient(): Promise<SchedState> {
  const { data, error } = await supabaseBrowser().from("settings").select("weekly, exceptions, override").eq("id", 1).single();
  if (error) throw error;
  return {
    weekly: (data.weekly as WeeklyHours) ?? defaultWeeklyHours(),
    exceptions: (data.exceptions as Record<string, Exception>) ?? {},
    override: (data.override as Override | null) ?? null,
  };
}

export async function dbSaveScheduleClient(
  weekly: WeeklyHours,
  ex: Record<string, Exception>,
  override: Override | null = null
): Promise<void> {
  const { error } = await supabaseBrowser()
    .from("settings")
    .update({ weekly, exceptions: ex, override, updated_at: new Date().toISOString() })
    .eq("id", 1);
  if (error) throw error;
  applySchedule(weekly, ex);
  setOverride(override);
  notifyScheduleChange();
}

export async function dbSetAvailabilityOverride(mode: "auto" | "in" | "out"): Promise<void> {
  const override = mode === "auto" ? null : { date: ymd(new Date()), mode };
  await dbSaveScheduleClient(weeklyHours, exceptions, override);
}

// Subscribe to DB-mode schedule/override changes (mirrors lib/store.ts's
// useScheduleTick for mock mode — this fires off notifyScheduleChange()).
export function useDbScheduleTick(): number {
  return useSyncExternalStore(onScheduleChange, () => tick, () => 0);
}
let tick = 0;
onScheduleChange(() => { tick++; });
