// ─────────────────────────────────────────────────────────────────────────────
// Server-only Supabase data access (service_role). Same shapes as lib/store.ts
// so callers don't need to branch on shape — only on which module they import.
// Used by /api routes and the WhatsApp webhook, which have no browser tab and
// so can't use lib/store.ts's localStorage-backed functions.
// ─────────────────────────────────────────────────────────────────────────────
import { supabaseAdmin } from "@/lib/supabase-admin";
import { clinic, type Lang } from "@/clinic.config";
import {
  defaultWeeklyHours, allSlotsFor, ymd, nowIST, isPastLeadTime,
  type WeeklyHours, type Exception, type Override, type SchedState,
} from "@/lib/schedule";
import type { Appt, ApptStatus, Source } from "@/lib/store";
import type { ServerBotState } from "@/lib/bot";
import { SlotTakenError, InvalidSlotError, PendingHoldError, DuplicateSlotError } from "@/lib/errors";
import { createPaymentLink } from "@/lib/razorpay";
import { normalizePhone, phoneMatchVariants } from "@/lib/phone";
import { report } from "@/lib/bugdesk";

// Same window the payment-timeout cron uses: a payment_pending hold releases
// once it's older than this. Defined here (and mirrored by the cron route) so
// the lazy sweep and the cron agree on how stale is stale.
export const PAYMENT_WINDOW_MS = 15 * 60 * 1000;

// Lazy expiry for lazily-seeming stale holds: any slot lookup frees
// payment_pending rows older than the payment window before answering. The
// GitHub cron is the backstop for items nobody ever looks at; this covers the
// question that actually matters to the next patient — "is this slot free?" —
// within one lookup, even when the cron hasn't fired on time (free-tier
// Actions schedules can lag for hours).
async function expireStalePendingHolds(): Promise<void> {
  const cutoff = new Date(Date.now() - PAYMENT_WINDOW_MS).toISOString();
  const { error } = await supabaseAdmin()
    .from("appointments")
    .update({ status: "cancelled" })
    .eq("status", "payment_pending")
    .lt("created_at", cutoff)
    .eq("paid", false); // never cancel a row the desk collected cash for
  if (error) throw error;
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

// A patient's active (not cancelled/done) appointments, nearest first — the
// lookup a cancel request resolves against instead of trusting a single
// remembered booking id, since a phone can have more than one appointment
// on file (e.g. family members sharing a number) and a stale id would
// cancel the wrong one.
// The status of one appointment, or null when it doesn't exist. Used by the
// payment-link route to exempt fresh (payment_pending) bookings from the OTP
// gate — those were just created through the ungated booking flow, so gating
// their payment step adds nothing but a dead end for a patient mid-checkout.
export async function dbApptStatus(id: string): Promise<ApptStatus | null> {
  const { data, error } = await supabaseAdmin()
    .from("appointments")
    .select("status")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return (data?.status as ApptStatus) ?? null;
}

export async function dbGetAppt(id: string): Promise<Appt | null> {
  const { data, error } = await supabaseAdmin()
    .from("appointments")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data ? rowToAppt(data) : null;
}

// Matches every stored shape of the same number (see phoneMatchVariants): a
// WhatsApp booking can carry the sender's 91-country-code id verbatim, while
// the patient types only the local 10 digits on the website, so a naive
// `.eq("phone", ...)` against either form silently misses the other.
export async function dbActiveAppointmentsByPhone(phone: string, includePending = false): Promise<Appt[]> {
  const statuses = ["reserved", "confirmed", "waiting", "consulting"];
  // payment_pending rows are excluded everywhere except the payment-link
  // lookup, which needs to find a just-booked appointment before it's paid.
  if (includePending) statuses.push("payment_pending");
  const { data, error } = await supabaseAdmin()
    .from("appointments")
    .select("*")
    .in("phone", phoneMatchVariants(phone))
    .in("status", statuses)
    .order("appt_date", { ascending: true })
    .order("appt_time", { ascending: true });
  if (error) throw error;
  return (data ?? []).map(rowToAppt);
}

type DbApptRow = {
  id: string; token: number; name: string; phone: string | null; age: number | null;
  gender: "M" | "F" | null; appt_date: string; appt_time: string; status: string;
  source: string; fee: number; paid: boolean; paid_via: string | null;
  razorpay_payment_id: string | null; razorpay_refund_id: string | null;
  refunded_at: string | null; reminder_sent_at: string | null; created_at: string;
  notes: string | null; patient_code: string | null; claim_type: string | null;
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
    createdAt: new Date(r.created_at).getTime(),
    notes: r.notes ?? null,
    patientCode: r.patient_code ?? null,
    claimType: r.claim_type as "returning_unverified" | "review_free" | null,
    paymentDeadlineAt: null, // server-side: expiry is enforced by the payment-timeout cron against created_at
  };
}

// Creates the patient row for a phone if it doesn't exist yet. The upsert
// targets the patients phone unique index: a returning phone gets its existing
// row back (id + ROC code), a first insert gets a fresh ROC-#### via the
// patients_code_trigger. Patients are created ONLY from a confirmed booking —
// dbAddBooking defers a new phone until the booking is real (the payment
// webhook flipping payment_pending→reserved, or a claim booking landing
// straight in reserved), so an unpaid hold that times out NEVER leaves a
// patient row behind. The appointment keeps a name/phone snapshot regardless.
async function ensurePatient(
  name: string,
  phone: string
): Promise<{ id: string | null; patientCode: string | null }> {
  const { data: patient, error } = await supabaseAdmin()
    .from("patients")
    .upsert({ name, phone }, { onConflict: "phone" })
    .select("id, patient_code")
    .single();
  if (error) throw error;
  return { id: patient?.id ?? null, patientCode: patient?.patient_code ?? null };
}

// A patient booking a specific date + time (from the website or WhatsApp).
// replacePending: when true, cancel any existing payment_pending row for this
// phone before inserting (the patient is choosing to start over rather than
// pay the old hold).
//
// claim: a self-declared payment exemption. "review_free" (a follow-up visit
// within the review window) books at ₹0, nothing is collected. "returning_unverified"
// is a returning patient who pays a reduced ₹350 at the clinic counter, never
// online — the admin queue flags the row so the desk collects it. In both
// cases there's no pre-launch patient record to check the
// self-declaration against, so it's trusted at booking time and verified in
// person at the desk. A claimed booking skips payment_pending and Razorpay
// entirely and lands straight in "reserved".
export async function dbAddBooking(input: {
  name: string; phone: string; age: number; gender?: "M" | "F" | null; date: string; time: string; source?: Source; replacePending?: boolean;
  claim?: "returning_unverified" | "review_free";
}): Promise<Appt> {
  const db = supabaseAdmin();
  const name = input.name.trim();
  // Canonical 10-digit form (strips +91/91/0 country prefixes): the patient
  // lookup matches on the same form, so a WhatsApp booking confirmed with the
  // sender's 91-prefixed id has to store the same number the patient types.
  const phone = normalizePhone(input.phone);

  // /api/book pre-checks both of these too, but that's a check-then-act race
  // (schedule can change, or the clock can tick past midnight, between the
  // check and this write), and other callers — the WhatsApp Flow's nfm_reply
  // submission in particular — don't pre-check at all. This is the one place
  // every booking source funnels through, so it's the right place to make
  // "can't book a past date, or outside clinic hours" hold for real.
  const now = nowIST();
  if (input.date < ymd(now)) throw new InvalidSlotError();
  if (isPastLeadTime(input.date, input.time, now)) throw new InvalidSlotError();
  const sched = await dbLoadSchedule();
  const openSlots = allSlotsFor(new Date(`${input.date}T00:00:00`), sched);
  if (!openSlots.includes(input.time)) throw new InvalidSlotError();

  // A phone holding an unpaid booking can't book a second slot. The first
  // booking sits in payment_pending (slot held, Razorpay link out) until the
  // webhook reserves it or the 15-min payment-timeout cron frees it; allowing
  // a second booking meanwhile would hold two slots for nothing. When
  // replacePending is true (patient chose "Start over"), cancel the old
  // row instead of refusing. (The WhatsApp sender books under their own number
  // by default, and the site submits the number on the form, so the phone here
  // is the same one the hold sits under.)
  //
  // Slot lookups (dbTakenSlots/dbTakenSlotsRange) used to lazily expire stale
  // pending holds on every availability check, well before the cron got to
  // them; now that slot capacity is unlimited there's no availability check
  // left to piggyback on, so the expiry runs right here instead, keeping a
  // patient from being stuck behind their own stale hold if the cron lags.
  await expireStalePendingHolds();
  if (phone) {
    const { data: pending, error: pendErr } = await db
      .from("appointments")
      .select("id, appt_date, appt_time")
      .eq("phone", phone)
      .eq("status", "payment_pending");
    if (pendErr) throw pendErr;
    if ((pending ?? []).length > 0) {
      if (!input.replacePending) throw new PendingHoldError();
      // A claim re-booking the SAME slot converts the hold in place instead of
      // cancelling it and inserting a fresh row. The old cancel+insert left the
      // discarded hold behind as a visible "Cancelled" ghost in the admin queue
      // next to the real booking (the queue hides payment_pending but shows
      // cancelled). Conversion keeps the original token and never creates a
      // phantom row. appointments_pending_hold_idx guarantees at most one hold
      // per phone, so pending[0] is the only one.
      const hold = pending![0];
      const sameSlot = hold.appt_date === input.date && hold.appt_time === input.time;
      if (input.claim && sameSlot) {
        const { data: converted, error: convErr } = await db
          .from("appointments")
          .update({
            status: "reserved",
            claim_type: input.claim,
            fee: input.claim === "review_free" ? 0 : clinic.returningFee,
            paid: input.claim === "review_free",
            source: input.source ?? "website",
            name: input.name,
          })
          .eq("id", hold.id)
          // Guard: if the Razorpay webhook already flipped this hold to
          // reserved (patient paid while the claim request was in flight),
          // skip the conversion — maybeSingle() yields null and we fall
          // through to a fresh insert, same as this code did before.
          .eq("status", "payment_pending")
          .select("*")
          .maybeSingle();
        if (convErr) throw convErr;
        if (converted) {
          // The hold was created patientless (deferred at booking, see above);
          // converting it into a confirmed claim booking IS a confirmation, so
          // promote the phone into patients now and stamp the code onto the row.
          if (phone && !converted.patient_id) {
            const created = await ensurePatient(name, phone);
            const { error: backErr } = await db
              .from("appointments")
              .update({ patient_id: created.id, patient_code: created.patientCode })
              .eq("id", converted.id);
            if (backErr) throw backErr;
            return rowToAppt({ ...converted, patient_id: created.id, patient_code: created.patientCode });
          }
          return rowToAppt(converted);
        }
      } else {
        // Hold for a different slot (defensive — the UI never produces this)
        // or no claim set: cancel so the fresh booking below can proceed.
        const ids = pending!.map((p) => p.id);
        const { error: cancelErr } = await db
          .from("appointments")
          .update({ status: "cancelled" })
          .in("id", ids)
          .eq("status", "payment_pending");
        if (cancelErr) throw cancelErr;
      }
    }
  }

  // Same phone + same date + same time, with a live row already there, is a
  // duplicate: the patient is stacking a second queue token on a slot they
  // already hold. The pending-hold guard above can't catch this — once the
  // first booking is paid (status reserved) the phone has no payment_pending
  // row, and claim bookings skip the hold state entirely. payment_pending is
  // included here so an in-flight payment still counts as a live booking;
  // cancelled/done rows are dead and don't block. Runs after the hold block
  // so a claim converting its own hold in place (returns early above) and a
  // replacePending cancel are never mistaken for a duplicate.
  if (phone) {
    const { data: dup } = await db
      .from("appointments")
      .select("id")
      .in("phone", phoneMatchVariants(phone))
      .eq("appt_date", input.date)
      .eq("appt_time", input.time)
      .in("status", ["reserved", "confirmed", "waiting", "consulting", "payment_pending"])
      .maybeSingle();
    if (dup) throw new DuplicateSlotError();
  }

  // Patient record: the patients table (deduped by phone) is the source of
  // truth for the ROC code — a returning phone keeps the same patient row, so
  // their visit history and code stay together. Query BEFORE the upsert so we
  // know whether a phone already had a record (the upsert's ON CONFLICT
  // swallows that distinction). A blank phone can't be matched, so it never
  // gets a code here. (A returning patient's discounted fee is decided by the
  // claim below; the online flat rate stays for new patients.)
  let patientId: string | null = null;
  let patientCode: string | null = null;
  let fee: number = clinic.consultationFee;
  if (phone) {
    const { data: existing, error: existingErr } = await db
      .from("patients")
      .select("id, patient_code")
      .eq("phone", phone)
      .maybeSingle();
    if (existingErr) throw existingErr;
    if (existing) {
      patientId = existing.id;
      patientCode = existing.patient_code ?? null;
    } else {
      // No patient record yet — defer creation until the booking CONFIRMS.
      // Patients exist for confirmed visits only: an unpaid hold that the
      // payment-timeout cron cancels must not leave a patient row behind
      // (that would mislabel an abandoned phone as "returning" and inflate
      // the patient list). ensurePatient creates the row the moment the
      // booking becomes real — the webhook flipping this hold to reserved,
      // or a claim booking landing straight in reserved below.
      patientId = null;
      patientCode = null;
    }
  }

  // The final claim: an explicit claim is trusted at booking time (verified in
  // person — there's no pre-launch record to check it against). "review_free"
  // books at ₹0; "returning_unverified" keeps a reduced ₹350 fee but pays at
  // the clinic (paid stays false, the desk collects it). Every other booking
  // pays the flat ₹400 online.
  const claim = input.claim;
  if (claim === "review_free") fee = 0;
  else if (claim === "returning_unverified") fee = clinic.returningFee;

  // A claimed booking is confirmed at insert (status "reserved" below — no
  // Razorpay step, no hold to wait on), so if it's the phone's first-ever
  // booking this is a genuinely confirmed patient: create the row now so the
  // appointment carries the ROC code. A non-claim hold stays patientless until
  // the payment webhook confirms it (see dbMarkPaidByPaymentLink).
  if (claim && !patientId && phone) {
    const created = await ensurePatient(name, phone);
    patientId = created.id;
    patientCode = created.patientCode;
  }

  // Bookings start payment_pending (not reserved): the slot is held + the
  // Razorpay link has a reference_id, but nothing shows in any queue until
  // the webhook flips it to reserved. A free-review claim skips that entirely
  // — there's no Razorpay step, so it goes straight to "reserved" with
  // `paid` true (₹0, nothing ever collected).
  // Slot capacity is unlimited, so there's no race to guard against there
  // anymore — but the per-day token sequence can still collide under
  // concurrent inserts (two patients both computing "next token" before
  // either insert lands), so that's retried a few times with a freshly
  // recomputed token before giving up.
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
        patient_code: patientCode,
        name,
        phone,
        age: input.age,
        gender: input.gender ?? null,
        reason: "Consultation",
        appt_date: input.date,
        appt_time: input.time,
        status: claim ? "reserved" : "payment_pending",
        source: input.source ?? "website",
        fee,
        paid: claim === "review_free",
        claim_type: claim ?? null,
      })
      .select("*")
      .single();

    if (!error) return rowToAppt(row);
    if (error.code !== "23505") throw error;
    // The application-level check above (lines ~220-228) is a plain
    // SELECT-then-INSERT and can race two concurrent bookings for the same
    // phone past it; appointments_pending_hold_idx is the real guard, and a
    // violation here means we lost that race — same error the pre-check throws.
    if (error.message.includes("appointments_pending_hold_idx")) throw new PendingHoldError();
    // The same-phone/same-date/same-time partial unique index can also fire
    // under a double-tap race (two concurrent bookings passed the SELECT
    // guard above, then both INSERTed); same error the pre-check throws.
    if (error.message.includes("appointments_slot_guard")) throw new DuplicateSlotError();
    // otherwise a token collision under concurrent inserts: retry with a fresh token
  }
  throw new SlotTakenError();
}

// Moves an existing appointment to a new date/time, used by patient
// self-service reschedule. Same availability check + race guard as
// dbAddBooking, minus the pending-hold check (a reschedule doesn't touch
// that guard at all).
export async function dbRescheduleAppointment(id: string, date: string, time: string): Promise<Appt> {
  const now = nowIST();
  if (date < ymd(now)) throw new InvalidSlotError();
  if (isPastLeadTime(date, time, now)) throw new InvalidSlotError();
  const sched = await dbLoadSchedule();
  const openSlots = allSlotsFor(new Date(`${date}T00:00:00`), sched);
  if (!openSlots.includes(time)) throw new InvalidSlotError();

  // Status guard on the write: only a real (paid) appointment may move. A
  // payment_pending hold is never rescheduled (it isn't confirmed yet — both
  // callers send the CONFIRM template after this, and confirming an unpaid
  // booking would violate the payment-first rule), and a cancelled row is
  // immutable. A guard that matches nothing is surfaced as not_found.
  const { data, error } = await supabaseAdmin()
    .from("appointments")
    .update({ appt_date: date, appt_time: time })
    .eq("id", id)
    .in("status", ["reserved", "confirmed", "waiting", "consulting"])
    .select("*")
    .maybeSingle();

  if (!error && data) return rowToAppt(data);
  if (!error) throw new Error("not_found"); // status guard blocked the move
  throw error;
}

export async function dbSetStatus(id: string, status: ApptStatus): Promise<void> {
  await dbSetStatusReturning(id, status);
}

// Same write as dbSetStatus, but returns the updated row — needed by
// /api/appointments/status to fire a WhatsApp cancellation notice.
export async function dbSetStatusReturning(id: string, status: ApptStatus): Promise<Appt> {
  const db = supabaseAdmin();
  // When marking "done", set paid+paid_via only if the appointment is still
  // unpaid — never overwrite an existing paid_via:"razorpay" tag from a
  // webhook. Two calls: first the conditional paid-write, then the status.
  if (status === "done") {
    await db
      .from("appointments")
      .update({ paid: true, paid_via: "cash" })
      .eq("id", id)
      .eq("paid", false);
  }
  const { data, error } = await db
    .from("appointments")
    .update({ status })
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;
  return rowToAppt(data);
}

// Returns a payment link URL for one of a phone's active appointments,
// creating it on first call and reusing the stored one on every repeat tap
// (a fresh Razorpay Payment Link on every click would leave a trail of
// duplicate, never-completed links behind). Throws a plain Error — the
// caller (/api/payments/link) maps that to a 502, distinct from the 404s it
// already returns for a bad id/phone pair.
// A placeholder written into razorpay_payment_link_id while this appointment's
// real link is being minted — see the claim step below.
const PAYMENT_LINK_CLAIM = "__creating__";

export async function dbGetOrCreatePaymentLink(id: string, phone: string, attempt = 0): Promise<string> {
  const owned = await dbActiveAppointmentsByPhone(phone, true);
  const appt = owned.find((a) => a.id === id);
  if (!appt) throw new Error("not_found");
  if (appt.paid) throw new Error("already_paid");
  // Claim bookings (returning/Free review) must never be charged online — the
  // clinic collects them at the counter. Refuse outright so no code path can
  // mint a Razorpay link for one.
  if (appt.claimType) throw new Error("claim_no_payment");

  const db = supabaseAdmin();
  const { data: row, error } = await db
    .from("appointments")
    .select("razorpay_payment_link_id, razorpay_payment_link_url")
    .eq("id", id)
    .single();
  if (error) throw error;
  if (row.razorpay_payment_link_id && row.razorpay_payment_link_id !== PAYMENT_LINK_CLAIM && row.razorpay_payment_link_url) {
    return row.razorpay_payment_link_url as string;
  }

  // Two concurrent "Pay now" taps (two devices, or a retried request) could
  // otherwise both pass the check above and both mint a real Razorpay link —
  // two live, payable links for one slot, and no guarantee the app ever
  // records whichever one the patient actually pays. Claim the right to
  // create it first: only the caller whose UPDATE actually flips a NULL wins.
  if (row.razorpay_payment_link_id !== PAYMENT_LINK_CLAIM) {
    const { data: claimed, error: claimErr } = await db
      .from("appointments")
      .update({ razorpay_payment_link_id: PAYMENT_LINK_CLAIM })
      .eq("id", id)
      .is("razorpay_payment_link_id", null)
      .select("id")
      .maybeSingle();
    if (claimErr) throw claimErr;
    if (!claimed) return waitForClaimedLink(id, phone, attempt); // lost the race
  } else {
    return waitForClaimedLink(id, phone, attempt); // already mid-claim from a prior read
  }

  const link = await createPaymentLink(appt);
  if (!link) {
    // Self-heal: release the claim so a retry (the patient tapping "Pay now"
    // again) isn't permanently blocked by a stuck placeholder.
    await db.from("appointments").update({ razorpay_payment_link_id: null }).eq("id", id).eq("razorpay_payment_link_id", PAYMENT_LINK_CLAIM);
    throw new Error("razorpay_unavailable");
  }

  const { error: updateErr } = await db
    .from("appointments")
    .update({ razorpay_payment_link_id: link.id, razorpay_payment_link_url: link.short_url })
    .eq("id", id);
  if (updateErr) throw updateErr;

  return link.short_url;
}

// Polls briefly for the race's winner to finish minting the link. Bounded to
// one retry of the whole flow so a winner that crashed mid-claim (leaving the
// placeholder stuck forever) doesn't wedge the loser in an infinite loop —
// on the retry, if the placeholder never resolves, the same code path will
// see it's still stuck and eventually surface an error to the caller.
async function waitForClaimedLink(id: string, phone: string, attempt: number): Promise<string> {
  const db = supabaseAdmin();
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const { data: fresh, error } = await db
      .from("appointments")
      .select("razorpay_payment_link_id, razorpay_payment_link_url")
      .eq("id", id)
      .single();
    if (error) throw error;
    if (fresh.razorpay_payment_link_id && fresh.razorpay_payment_link_id !== PAYMENT_LINK_CLAIM && fresh.razorpay_payment_link_url) {
      return fresh.razorpay_payment_link_url as string;
    }
    if (!fresh.razorpay_payment_link_id) break; // the winner's Razorpay call failed and self-healed
  }
  if (attempt >= 1) throw new Error("razorpay_unavailable");
  return dbGetOrCreatePaymentLink(id, phone, attempt + 1);
}

// Called by the Razorpay webhook on payment_link.paid. Flipping paid also
// promotes a payment_pending booking to reserved — that's the moment the
// appointment becomes real and shows up in the queues. A legacy unpaid
// appointment already sitting in reserved/confirmed/waiting keeps its status
// and is only marked paid (money landed on a real slot, no state to move).
// Guards is("paid", false) so a duplicate webhook delivery (Razorpay retries
// on anything but a 2xx) is a harmless no-op rather than a second WhatsApp
// confirmation, and excludes cancelled rows so a webhook that lands after the
// payment-timeout cron cancelled the hold can never resurrect it (the slot was
// freed for someone else).
export async function dbMarkPaidByPaymentLink(
  paymentLinkId: string,
  paymentId?: string,
  capturedAmountPaise?: number
): Promise<Appt | null> {
  const db = supabaseAdmin();
  // Read the row first so a non-payment_pending status is preserved on the
  // write rather than force-downgraded to reserved.
  const { data: row, error: readErr } = await db
    .from("appointments")
    .select("id, status, fee")
    .eq("razorpay_payment_link_id", paymentLinkId)
    .maybeSingle();
  if (readErr) throw readErr;
  if (!row || row.status === "cancelled") return null;

  // The link was created for exactly row.fee (see createPaymentLink), so the
  // captured amount should always match it in paise. Never block on a
  // mismatch — the money already moved at Razorpay, and refusing to record
  // it here would just leave a paying patient stuck with no visible booking
  // while the clinic still has the cash — but log loudly so staff can catch
  // a tampered/duplicated link or a fee that changed after the link issued.
  if (typeof capturedAmountPaise === "number" && capturedAmountPaise !== row.fee * 100) {
    console.error(
      "payments/webhook: captured amount does not match appointment fee",
      JSON.stringify({ paymentLinkId, paymentId, capturedAmountPaise, expectedPaise: row.fee * 100 })
    );
    await report({ source: "payments/webhook", message: "Captured amount does not match appointment fee", severity: "critical", info: { paymentLinkId, paymentId, capturedAmountPaise, expectedPaise: row.fee * 100 } });
  }

  const status = row.status === "payment_pending" ? "reserved" : row.status;
  const { data, error } = await db
    .from("appointments")
    .update({ paid: true, paid_via: "razorpay", razorpay_payment_id: paymentId ?? null, status })
    .eq("id", row.id)
    .eq("paid", false)
    .not("status", "eq", "cancelled") // race-guard against the timeout cron
    .select("*")
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  // A payment_pending hold can exist without a patient row (patients are
  // created only on confirmation, see dbAddBooking) — this paid flip to
  // reserved IS that confirmation, so promote the phone into patients now and
  // stamp the code onto the appointment. The backfill must not fail the
  // webhook: a non-2xx makes Razorpay retry, and the retry hits the paid:false
  // guard above as a harmless no-op, so an exception here would leave a real,
  // paid appointment permanently patientless. The money is recorded either way;
  // log loudly for a manual fix when the backfill itself fails.
  if (data.phone && !data.patient_id) {
    try {
      const created = await ensurePatient(data.name, data.phone);
      const { error: backErr } = await db
        .from("appointments")
        .update({ patient_id: created.id, patient_code: created.patientCode })
        .eq("id", data.id);
      if (backErr) throw backErr;
      return rowToAppt({ ...data, patient_id: created.id, patient_code: created.patientCode });
    } catch (err) {
      console.error("dbMarkPaidByPaymentLink: patient backfill failed after payment", err);
      await report({ source: "payments/webhook", message: "Payment recorded but patient row backfill failed", severity: "critical", info: { apptId: data.id, phone: data.phone } });
    }
  }
  return rowToAppt(data);
}

// Records that a paid appointment was refunded (a Razorpay refund id + the
// moment). The appointment keeps paid=true and paid_via='razorpay' — money
// really did come in then go back out; refunded_at is what marks the return,
// so revenue rollups can subtract refunded rows. No-op-safe: only flips rows
// that are actually paid via Razorpay and not already refunded.
export async function dbMarkRefunded(id: string, refundId: string): Promise<void> {
  const { error } = await supabaseAdmin()
    .from("appointments")
    .update({ razorpay_refund_id: refundId, refunded_at: new Date().toISOString() })
    .eq("id", id)
    .eq("paid", true)
    .eq("paid_via", "razorpay")
    .is("refunded_at", null);
  if (error) throw error;
}

// The automatic-reminder cron's idempotency guard: marks an appointment as
// reminded with a conditional update (only the row still carrying
// reminder_sent_at = NULL flips), so two overlapping cron runs can never both
// "win" and double-message a patient. Returns whether THIS caller set the
// flag — the caller sends only when it returns true.
export async function dbMarkReminderSent(id: string): Promise<boolean> {
  // An update chained to `.select("id")` returns the rows it actually changed;
  // zero rows means the conditional `.is("reminder_sent_at", null)` matched
  // nothing, i.e. another tick already marked this one. That's the "won the
  // race" signal the caller sends on.
  const { data, error } = await supabaseAdmin()
    .from("appointments")
    .update({ reminder_sent_at: new Date().toISOString() })
    .eq("id", id)
    .is("reminder_sent_at", null)
    .select("id");
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

// Called by the cron when a reminder send failed, so a later tick retries
// instead of losing the nudge forever to a transient Meta hiccup.
export async function dbClearReminderSent(id: string): Promise<void> {
  const { error } = await supabaseAdmin()
    .from("appointments")
    .update({ reminder_sent_at: null })
    .eq("id", id);
  if (error) throw error;
}

// The doctor daily-digest cron's idempotency guard — a conditional insert
// (primary key on date) so a GitHub Actions retry or a second near-boundary
// trigger can never send the digest twice for the same IST date. Returns
// whether THIS caller just inserted the row — the caller sends only then.
export async function dbMarkDoctorDigestSent(date: string): Promise<boolean> {
  const { error } = await supabaseAdmin().from("doctor_digest_sent").insert({ date });
  if (!error) return true;
  if (error.code === "23505") return false; // unique violation — already sent today
  throw error;
}

// The session-digest cron's idempotency guard — a conditional insert keyed on
// (date, window_start) so overlapping ticks or a GitHub Actions retry can never
// send the same session's digest twice. Returns whether THIS caller inserted
// the row — the caller sends only then.
export async function dbMarkSessionDigestSent(date: string, windowStart: string): Promise<boolean> {
  const { error } = await supabaseAdmin()
    .from("session_digest_sent")
    .insert({ date, window_start: windowStart });
  if (!error) return true;
  if (error.code === "23505") return false; // already sent for this session
  throw error;
}

// A transient Resend failure shouldn't lose a session's digest forever — clear
// the marker so the next tick retries within the pre-session lead window.
export async function dbClearSessionDigestSent(date: string, windowStart: string): Promise<void> {
  const { error } = await supabaseAdmin()
    .from("session_digest_sent")
    .delete()
    .eq("date", date)
    .eq("window_start", windowStart);
  if (error) throw error;
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
  // No row yet = a phone number the bot has never talked to — gate it on the
  // one-time language pick before anything else, same as the website's
  // language switcher up front.
  if (!data) return { lang: "en", state: { stage: "await_lang" }, lastWamid: null };

  let state = (data.state as ServerBotState) ?? { stage: "idle" };
  const age = Date.now() - new Date(data.updated_at).getTime();
  // The day/window/range picker parks its progress under stage "idle" (see
  // BotState.pendingDate's own comment in lib/bot.ts) — a bare stage check
  // here missed that, so a patient who tapped a day chip and vanished for
  // days would come back to the bot silently replaying availability against
  // that long-past date (empty slots, or a confusing "Today"/"Tomorrow"
  // label for a date that's neither) instead of starting fresh. Anything
  // beyond bare idle counts as mid-flow for staleness purposes.
  const midFlow =
    (state.stage !== "idle" && state.stage !== "await_lang") ||
    Boolean(state.pendingDate || state.pendingWindow || state.pendingRange || state.resched || state.slot);
  if (midFlow && age > SESSION_STALE_MS) state = { stage: "idle" };

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
