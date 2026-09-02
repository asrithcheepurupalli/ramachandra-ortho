// ─────────────────────────────────────────────────────────────────────────────
// Server-only Supabase data access (service_role). Same shapes as lib/store.ts
// so callers don't need to branch on shape — only on which module they import.
// Used by /api routes and the WhatsApp webhook, which have no browser tab and
// so can't use lib/store.ts's localStorage-backed functions.
// ─────────────────────────────────────────────────────────────────────────────
import { supabaseAdmin } from "@/lib/supabase";
import { clinic, type Lang } from "@/clinic.config";
import {
  defaultWeeklyHours, slotsFor, ymd, nowIST,
  type WeeklyHours, type Exception, type Override, type SchedState,
} from "@/lib/schedule";
import type { Appt, ApptStatus, Source } from "@/lib/store";
import type { ServerBotState } from "@/lib/bot";
import { SlotTakenError, InvalidSlotError } from "@/lib/errors";

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

  // /api/book pre-checks both of these too, but that's a check-then-act race
  // (schedule can change, or the clock can tick past midnight, between the
  // check and this write), and other callers — the WhatsApp Flow's nfm_reply
  // submission in particular — don't pre-check at all. This is the one place
  // every booking source funnels through, so it's the right place to make
  // "can't book a past date, or outside clinic hours" hold for real.
  if (input.date < ymd(nowIST())) throw new InvalidSlotError();
  const sched = await dbLoadSchedule();
  const openSlots = slotsFor(new Date(`${input.date}T00:00:00`), [], sched);
  if (!openSlots.includes(input.time)) throw new InvalidSlotError();

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

  // A partial unique index on (appt_date, appt_time) where status <> 'cancelled'
  // is the real guard against two patients landing the same slot in a race;
  // the per-day token sequence can also collide under concurrent inserts, so
  // both are retried a few times (with a freshly recomputed token) before
  // giving up.
  for (let attempt = 0; attempt < 5; attempt++) {
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

    if (!error) return rowToAppt(row);
    if (error.code !== "23505") throw error;
    if (error.message.includes("appointments_slot_idx")) throw new SlotTakenError();
    // otherwise a token collision under concurrent inserts: retry with a fresh token
  }
  throw new SlotTakenError();
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

// A session mid-flow (awaiting a name/phone) that's gone quiet this long is
// treated as abandoned rather than resumed — otherwise a stray message days
// later ("ok") gets interpreted as the answer to a prompt the patient has
// long forgotten, e.g. booked as a patient literally named "ok".
const SESSION_STALE_MS = 30 * 60 * 1000;

// Per-phone WhatsApp conversation state, since a webhook route is stateless
// between HTTP requests — this is the only memory the bot has across turns.
// lastWamid lets the webhook recognize (and skip) Meta's retry of a message
// it already processed; a stale in-progress stage is reset to idle here so
// every caller automatically gets a fresh start without repeating the check.
export async function dbLoadWaSession(
  phone: string
): Promise<{ lang: Lang; state: ServerBotState; lastWamid: string | null }> {
  const { data, error } = await supabaseAdmin()
    .from("wa_sessions")
    .select("lang, state, last_wamid, updated_at")
    .eq("phone", phone)
    .maybeSingle();
  if (error) throw error;
  if (!data) return { lang: "en", state: { stage: "idle" }, lastWamid: null };

  let state = (data.state as ServerBotState) ?? { stage: "idle" };
  const age = Date.now() - new Date(data.updated_at).getTime();
  if (state.stage !== "idle" && age > SESSION_STALE_MS) state = { stage: "idle" };

  return { lang: (data.lang as Lang) ?? "en", state, lastWamid: data.last_wamid ?? null };
}

export async function dbSaveWaSession(
  phone: string,
  lang: Lang,
  state: ServerBotState,
  wamid?: string
): Promise<void> {
  const { error } = await supabaseAdmin()
    .from("wa_sessions")
    .upsert(
      { phone, lang, state, ...(wamid ? { last_wamid: wamid } : {}), updated_at: new Date().toISOString() },
      { onConflict: "phone" }
    );
  if (error) throw error;
}
