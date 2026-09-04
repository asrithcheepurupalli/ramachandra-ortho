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
import { useAppts, type Appt, type Source } from "@/lib/store";

function rowToAppt(r: any): Appt {
  return {
    id: r.id,
    token: r.token,
    name: r.name,
    phone: r.phone ?? "",
    reason: r.reason,
    date: r.appt_date,
    time: r.appt_time,
    status: r.status,
    source: r.source,
    fee: r.fee,
    paid: r.paid,
    paidVia: r.paid_via ?? null,
    createdAt: new Date(r.created_at).getTime(),
  };
}

// ── live queue: full read + realtime subscription ───────────────────────────
function useDbAppts(): Appt[] {
  const [appts, setAppts] = useState<Appt[]>([]);
  useEffect(() => {
    if (!hasSupabase()) return;
    const db = supabaseBrowser();
    let cancelled = false;

    const load = async () => {
      const { data, error } = await db.from("appointments").select("*");
      if (!cancelled && !error) setAppts((data ?? []).map(rowToAppt));
    };
    load();

    const channel = db
      .channel("appointments-admin")
      .on("postgres_changes", { event: "*", schema: "public", table: "appointments" }, load)
      .subscribe();

    return () => { cancelled = true; db.removeChannel(channel); };
  }, []);
  return appts;
}

// Unconditionally calls both hooks (hasSupabase() is a build-time constant,
// so this never violates the rules of hooks) and picks the active one.
export function useAdminAppts(): Appt[] {
  const mock = useAppts();
  const db = useDbAppts();
  return hasSupabase() ? db : mock;
}

// ── walk-in / status / paid ──────────────────────────────────────────────────
export async function dbAddWalkIn(input: { name: string; phone: string; reason: string; source?: Source }): Promise<Appt> {
  const db = supabaseBrowser();
  const today = ymd(new Date());
  const name = input.name.trim();
  const phone = input.phone.trim();

  let patientId: string | null = null;
  if (phone) {
    const { data: patient, error: patientErr } = await db
      .from("patients")
      .upsert({ name, phone }, { onConflict: "phone" })
      .select("id")
      .single();
    if (patientErr) throw patientErr;
    patientId = patient?.id ?? null;
  }

  const { data: dayAppts, error: dayErr } = await db.from("appointments").select("token").eq("appt_date", today);
  if (dayErr) throw dayErr;
  const token = (dayAppts ?? []).reduce((m, a) => Math.max(m, a.token as number), 0) + 1;

  const { data: row, error } = await db
    .from("appointments")
    .insert({
      token,
      patient_id: patientId,
      name,
      phone,
      reason: input.reason.trim() || "Consultation",
      appt_date: today,
      appt_time: new Date().toTimeString().slice(0, 5),
      status: "waiting",
      source: input.source ?? "walkin",
      fee: clinic.consultationFee,
      paid: false,
    })
    .select("*")
    .single();
  if (error) throw error;
  return rowToAppt(row);
}

export async function dbTogglePaidClient(id: string, currentPaid: boolean): Promise<void> {
  const update: Record<string, unknown> = { paid: !currentPaid };
  // Staff manual toggle always represents cash collected at the clinic.
  if (!currentPaid) update.paid_via = "cash";   // toggling to paid
  else update.paid_via = null;                   // toggling to unpaid
  const { error } = await supabaseBrowser().from("appointments").update(update).eq("id", id);
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
