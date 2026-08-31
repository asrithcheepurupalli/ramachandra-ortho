// ─────────────────────────────────────────────────────────────────────────────
// Server-only Supabase data access (service_role). Same shapes as lib/store.ts
// so callers don't need to branch on shape — only on which module they import.
// Used by /api routes and the WhatsApp webhook, which have no browser tab and
// so can't use lib/store.ts's localStorage-backed functions.
// ─────────────────────────────────────────────────────────────────────────────
import { supabaseAdmin } from "@/lib/supabase";
import { clinic, type Lang } from "@/clinic.config";
import {
  defaultWeeklyHours,
  type WeeklyHours, type Exception, type Override, type SchedState,
} from "@/lib/schedule";
import type { Appt, ApptStatus, Source } from "@/lib/store";
import type { ServerBotState } from "@/lib/bot";

// Times already taken on a date (so the slot picker can hide them).
export async function dbTakenSlots(date: string): Promise<string[]> {
  const { data, error } = await supabaseAdmin()
    .from("appointments")
    .select("appt_time")
    .eq("appt_date", date)
    .neq("status", "cancelled");
  if (error) throw error;
  return (data ?? []).map((r) => r.appt_time as string);
}

// All appointments on a date (for the admin queue view and broadcast sends).
export async function dbApptsForDate(date: string): Promise<Appt[]> {
  const { data, error } = await supabaseAdmin()
    .from("appointments")
    .select("*")
    .eq("appt_date", date);
  if (error) throw error;
  return (data ?? []).map(rowToAppt);
}

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
    createdAt: new Date(r.created_at).getTime(),
  };
}

// A patient booking a specific date + time (from the website or WhatsApp).
export async function dbAddBooking(input: {
  name: string; phone: string; reason: string; date: string; time: string; source?: Source;
}): Promise<Appt> {
  const db = supabaseAdmin();
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

  const { data: dayAppts, error: dayErr } = await db
    .from("appointments")
    .select("token")
    .eq("appt_date", input.date);
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
      appt_date: input.date,
      appt_time: input.time,
      status: "reserved",
      source: input.source ?? "website",
      fee: clinic.consultationFee,
      paid: false,
    })
    .select("*")
    .single();
  if (error) throw error;
  return rowToAppt(row);
}

export async function dbSetStatus(id: string, status: ApptStatus): Promise<void> {
  await dbSetStatusReturning(id, status);
}

// Same write as dbSetStatus, but returns the updated row — needed by
// /api/appointments/status to fire a WhatsApp cancellation notice.
export async function dbSetStatusReturning(id: string, status: ApptStatus): Promise<Appt> {
  const { data, error } = await supabaseAdmin()
    .from("appointments")
    .update({ status, ...(status === "done" ? { paid: true } : {}) })
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;
  return rowToAppt(data);
}

export async function dbLoadSchedule(): Promise<SchedState> {
  const { data, error } = await supabaseAdmin()
    .from("settings")
    .select("weekly, exceptions, override")
    .eq("id", 1)
    .single();
  if (error) throw error;
  return {
    weekly: (data.weekly as WeeklyHours) ?? defaultWeeklyHours(),
    exceptions: (data.exceptions as Record<string, Exception>) ?? {},
    override: (data.override as Override | null) ?? null,
  };
}

export async function dbSaveSchedule(
  weekly: WeeklyHours,
  exceptions: Record<string, Exception>,
  override: Override | null = null
): Promise<void> {
  const { error } = await supabaseAdmin()
    .from("settings")
    .update({ weekly, exceptions, override, updated_at: new Date().toISOString() })
    .eq("id", 1);
  if (error) throw error;
}

// Per-phone WhatsApp conversation state, since a webhook route is stateless
// between HTTP requests — this is the only memory the bot has across turns.
export async function dbLoadWaSession(phone: string): Promise<{ lang: Lang; state: ServerBotState }> {
  const { data, error } = await supabaseAdmin()
    .from("wa_sessions")
    .select("lang, state")
    .eq("phone", phone)
    .maybeSingle();
  if (error) throw error;
  if (!data) return { lang: "en", state: { stage: "idle" } };
  return { lang: (data.lang as Lang) ?? "en", state: (data.state as ServerBotState) ?? { stage: "idle" } };
}

export async function dbSaveWaSession(phone: string, lang: Lang, state: ServerBotState): Promise<void> {
  const { error } = await supabaseAdmin()
    .from("wa_sessions")
    .upsert({ phone, lang, state, updated_at: new Date().toISOString() }, { onConflict: "phone" });
  if (error) throw error;
}
