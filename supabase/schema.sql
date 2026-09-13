-- ─────────────────────────────────────────────────────────────────────────────
-- Ramachandra Ortho Care — database schema
-- Run this in the Supabase SQL editor (or `supabase db push`) once the project
-- exists. Mirrors lib/store.ts so the mock layer swaps in cleanly.
-- ─────────────────────────────────────────────────────────────────────────────

create extension if not exists "pgcrypto";

-- Patients (deduped by phone; appointment keeps a name/phone snapshot too) ─────
create table if not exists public.patients (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  phone       text,
  patient_code text,                        -- human-readable ID e.g. ROC-0001
  created_at  timestamptz not null default now()
);
-- Patient codes: auto-assigned ROC-#### on insert (new phone), kept on upsert
-- (existing phone). The sequence is the only counter; gaps are fine.
create sequence if not exists patient_code_seq;
create or replace function assign_patient_code() returns trigger language plpgsql as $$
begin
  if new.patient_code is null then
    new.patient_code := 'ROC-' || lpad(nextval('patient_code_seq')::text, 4, '0');
  end if;
  return new;
end $$;
drop trigger if exists patients_code_trigger on public.patients;
create trigger patients_code_trigger before insert on public.patients
  for each row execute function assign_patient_code();
-- Backfill rows created before this migration so every patient has a code.
update public.patients set patient_code =
  'ROC-' || lpad(nextval('patient_code_seq')::text, 4, '0')
  where patient_code is null;
create unique index if not exists patients_code_idx on public.patients (patient_code);
-- Plain (non-partial) unique index — required so PostgREST's
-- `.upsert(..., { onConflict: "phone" })` can target it via ON CONFLICT
-- (a partial index can't be inferred as a conflict target without repeating
-- its WHERE predicate, which PostgREST doesn't do). NULLs don't collide
-- under a unique index, so callers must pass null (not "") for a blank phone.
create unique index if not exists patients_phone_idx on public.patients (phone);

-- Appointments ────────────────────────────────────────────────────────────────
create table if not exists public.appointments (
  id          uuid primary key default gen_random_uuid(),
  token       int  not null,
  patient_id  uuid references public.patients(id) on delete set null,
  name        text not null,
  phone       text,
  reason      text not null default 'Consultation',
  appt_date   date not null,
  appt_time   text not null,                 -- "HH:MM"
  status      text not null default 'reserved',  -- reserved|confirmed|waiting|consulting|done|cancelled|payment_pending
  source      text not null default 'website',   -- website|whatsapp|walkin
  fee         int  not null,
  paid        boolean not null default false,
  created_at  timestamptz not null default now(),
  unique (appt_date, token)
);
-- Razorpay Payment Links (optional online fee payment) — nullable, set once a
-- patient taps "Pay now"; a table created before these existed won't get them
-- from `create table if not exists` above, hence the idempotent add here.
alter table public.appointments add column if not exists razorpay_payment_link_id text;
alter table public.appointments add column if not exists razorpay_payment_link_url text;
-- Payment id of the actual Razorpay payment (from the payment_link.paid
-- webhook's payload.payment.entity.id) — needed to issue a refund on cancel.
-- NULL until a patient actually pays.
alter table public.appointments add column if not exists razorpay_payment_id text;
-- Refund audit trail: set to the Razorpay refund id when a paid appointment is
-- cancelled and the money is returned. Appointment stays paid:true (it WAS
-- paid); refunded_at is what records the return, so revenue views can exclude.
alter table public.appointments add column if not exists razorpay_refund_id text;
alter table public.appointments add column if not exists refunded_at timestamptz;
-- Payment channel audit trail: null = unpaid, 'cash' = staff/mark-done,
-- 'razorpay' = webhook. Needed so we can tell which payments went through
-- made.'s Razorpay account (temp bridge while the clinic's PAN is pending).
alter table public.appointments add column if not exists paid_via text;
-- Auto-reminder cron (app/api/cron/reminders): the instant the automatic
-- reminder was sent. NULL = not yet reminded; the cron's idempotency guard is
-- a conditional update on this being NULL, so a row is reminded exactly once.
alter table public.appointments add column if not exists reminder_sent_at timestamptz;
-- Post-visit review nudge cron (app/api/cron/review-nudge): the instant the
-- automatic "how was your visit? leave a Google review" nudge was sent (same
-- day, 3h after the slot, once status = done). NULL = not yet nudged; the same
-- conditional-update idempotency guard, so a visit is nudged exactly once.
alter table public.appointments add column if not exists review_nudge_sent_at timestamptz;
-- Free-review-visit nudge cron (app/api/cron/free-visit-nudge): the instant the
-- automatic "you have a free follow-up review visit within 10 days, book it"
-- nudge was sent for a consultation appointment. NULL = not yet nudged; the
-- same conditional-update idempotency guard, so a consulted patient who hasn't
-- booked their free review is nudged exactly once.
alter table public.appointments add column if not exists free_visit_reminder_sent_at timestamptz;
-- Payment-expiry re-nudge (app/api/cron/payment-timeout): cancel_reason marks
-- a row cancelled BECAUSE the 15-minute payment window lapsed (only the timeout
-- cron / lazy expiry stamp 'payment_timeout'; every deliberate cancel stays
-- null — this is what keeps resume from reviving a deliberate cancellation).
-- expired_payment_nudged_at is the one-time "your payment link expired" nudge
-- stamp; the cron's idempotency guard updates on this being NULL, and a failed
-- send is rolled back so the next tick retries inside Meta's 24h window.
alter table public.appointments add column if not exists cancel_reason text;
alter table public.appointments add column if not exists expired_payment_nudged_at timestamptz;
-- Doctor's free-text clinical note, written from the doctor portal only.
-- Never surfaced on the website/WhatsApp side — clinical content stays
-- internal to staff.
alter table public.appointments add column if not exists notes text;
-- Denormalized copy of the patient's readable ID (ROC-####). patient_code is
-- stable + unique per patient, so a copy on each appointment is safe and lets
-- queue/patients views show it without a join.
alter table public.appointments add column if not exists patient_code text;
-- Mandatory online payment (2026-09-08): new bookings start as payment_pending
-- (slot held, invisible to queues/admin/doctor). The Razorpay payment_link.paid
-- webhook flips the row to reserved atomically. A cron running every 5 minutes
-- cancels stale payment_pending rows older than 15 minutes, freeing their slot.
-- No ALTER needed beyond the status comment above — payment_pending is just a
-- text value in the existing status column; this block is for readability only.
create index if not exists appointments_date_idx on public.appointments (appt_date);
-- Slot capacity is intentionally unlimited: any number of patients may share
-- the same date+time. The old unique appointments_slot_idx that enforced a
-- one-booking-per-slot cap was removed in migration 008.

-- Clinic settings: schedule + override live in one row ─────────────────────────
create table if not exists public.settings (
  id          int primary key default 1 check (id = 1),
  weekly      jsonb not null,
  exceptions  jsonb not null default '{}'::jsonb,
  override    jsonb,
  updated_at  timestamptz not null default now()
);

-- seed the schedule the app uses (Mon-Sat 10:00-12:30 & 18:00-19:45, Sun holiday)
insert into public.settings (id, weekly) values (1, '{
  "0": [],
  "1": [{"start":"10:00","end":"12:30"},{"start":"18:00","end":"19:45"}],
  "2": [{"start":"10:00","end":"12:30"},{"start":"18:00","end":"19:45"}],
  "3": [{"start":"10:00","end":"12:30"},{"start":"18:00","end":"19:45"}],
  "4": [{"start":"10:00","end":"12:30"},{"start":"18:00","end":"19:45"}],
  "5": [{"start":"10:00","end":"12:30"},{"start":"18:00","end":"19:45"}],
  "6": [{"start":"10:00","end":"12:30"},{"start":"18:00","end":"19:45"}]
}'::jsonb)
on conflict (id) do nothing;

-- Staff allowlist ────────────────────────────────────────────────────────────
-- Single source of truth for who counts as clinic staff — the RLS policies
-- below and the app (proxy.ts, lib/auth-server.ts, via `.rpc("is_staff", ...)`)
-- all read this instead of each keeping their own copy. There used to be a
-- hardcoded SQL array here plus a separate ADMIN_EMAILS env var in the app;
-- both were removed once this table replaced them and no longer exist.
create table if not exists public.staff_emails (
  email text primary key
);
insert into public.staff_emails (email) values ('admin@ramachandracare.in')
on conflict (email) do nothing;
alter table public.staff_emails enable row level security;
-- Purely for routing which portal (/admin vs /doctor) a staff login lands on
-- after sign-in — is_staff() below is untouched and still just checks
-- presence in this table, so the access model (who counts as staff at all)
-- never depends on this column. 'staff' = front desk, 'doctor' = clinician.
alter table public.staff_emails add column if not exists role text not null default 'staff';
-- No select policy: nothing reads this table directly (not even staff via
-- PostgREST) — only is_staff()/staff_role() below do, and security definer
-- lets them see the table's rows regardless of RLS.

-- security definer so it can read staff_emails even though that table has no
-- policies granting anon/authenticated select access directly.
create or replace function public.is_staff(check_email text)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.staff_emails where email = lower(check_email)
  );
$$;
grant execute on function public.is_staff(text) to authenticated;
-- Postgres grants EXECUTE to PUBLIC by default on CREATE FUNCTION; revoke it so
-- anonymous PostgREST callers can't enumerate staff emails via is_staff().
revoke execute on function public.is_staff(text) from public;

-- Which portal a signed-in staff email should land on. Returns null for a
-- non-staff email (mirrors is_staff's "not on the list" case rather than
-- erroring), so callers treat null the same as the 'staff' default.
create or replace function public.staff_role(check_email text)
returns text
language sql
security definer
set search_path = public
stable
as $$
  select role from public.staff_emails where email = lower(check_email)
$$;
grant execute on function public.staff_role(text) to authenticated;
revoke execute on function public.staff_role(text) from public;

-- Row Level Security ─────────────────────────────────────────────────────────
-- Patient data is never exposed to anonymous visitors. Public booking + slot
-- availability go through server API routes using the service_role key, which
-- bypasses RLS. Staff use an authenticated session with full access.
--
-- IMPORTANT: public signup is ON for this Supabase project, so `to authenticated`
-- alone is NOT proof of staff — any stranger can self-register via Supabase's
-- own Auth API and get a valid `authenticated` session, then hit PostgREST
-- directly (bypassing this app's staff-gated routes entirely). Policies below
-- check the caller's email against public.staff_emails via is_staff().
alter table public.patients      enable row level security;
alter table public.appointments  enable row level security;
alter table public.settings      enable row level security;

-- staff (logged in AND on the allowlist) can do everything with patients + appointments
create policy "staff full patients" on public.patients for all to authenticated
  using (public.is_staff(auth.jwt() ->> 'email'))
  with check (public.is_staff(auth.jwt() ->> 'email'));
create policy "staff full appointments" on public.appointments for all to authenticated
  using (public.is_staff(auth.jwt() ->> 'email'))
  with check (public.is_staff(auth.jwt() ->> 'email'));

-- schedule/hours are safe to read publicly (drives the site banner); only staff edit
create policy "public read settings" on public.settings for select to anon, authenticated using (true);
create policy "staff update settings" on public.settings for update to authenticated
  using (public.is_staff(auth.jwt() ->> 'email'))
  with check (public.is_staff(auth.jwt() ->> 'email'));

-- Realtime: the admin dashboard subscribes to appointment changes for the live queue
alter publication supabase_realtime add table public.appointments;

-- WhatsApp conversation state ────────────────────────────────────────────────
-- A webhook route has no memory between requests, so the bot's in-progress
-- stage (idle / awaiting a name to complete a booking) and last booking (for
-- "cancel") persist here per phone number. Service-role only — the webhook is
-- the only thing that ever reads or writes it, so no RLS policies are needed.
create table if not exists public.wa_sessions (
  phone       text primary key,
  lang        text not null default 'en',
  state       jsonb not null default '{"stage":"idle"}'::jsonb,
  last_wamid  text,                                  -- last processed WhatsApp message id (retry dedupe)
  updated_at  timestamptz not null default now()
);
alter table public.wa_sessions enable row level security;
-- Idempotent for a table created before last_wamid existed (create table
-- if not exists above won't add columns to an already-existing table).
alter table public.wa_sessions add column if not exists last_wamid text;

-- Self-service OTP proof (cancel / reschedule / pay). One row per phone, so
-- the state is visible from every server function on Vercel — an in-memory
-- Map written by verify-otp is invisible to the reschedule route (each /api
-- route is its own Node instance). Codes are sha256-hashed; a stray log can
-- never leak a usable code. Service-role only — RLS is on with no policies.
create table if not exists public.otp_challenges (
  phone             text primary key,
  code_hash         text,                            -- sha256 of the live code, null once used/expired
  expires_at        timestamptz,                     -- code TTL (matches the template's 10 minutes)
  attempts          integer not null default 0,      -- bad guesses toward the 5-cap
  issue_count       integer not null default 0,      -- code issues inside the current window
  window_started_at timestamptz not null default now(),
  verified_until    timestamptz                      -- session proof, rides the same TTL
);
alter table public.otp_challenges enable row level security;

-- Doctor daily digest cron (app/api/cron/doctor-digest) idempotency guard —
-- one row per calendar date (IST) the digest was actually sent for, so a
-- GitHub Actions retry or a second near-boundary trigger never double-sends.
-- Service-role only — RLS is on with no policies.
create table if not exists public.doctor_digest_sent (
  date        date primary key,
  sent_at     timestamptz not null default now()
);
alter table public.doctor_digest_sent enable row level security;

-- Guard: only service-role may write Razorpay audit columns on appointments
-- (see supabase/migrations/014_lock_razorpay_columns.sql).
create or replace function public.guard_razorpay_columns()
returns trigger
language plpgsql
security definer
as $$
begin
  if auth.role() = 'service_role' then
    return new;
  end if;
  if (
    new.razorpay_payment_link_id is distinct from old.razorpay_payment_link_id or
    new.razorpay_payment_link_url is distinct from old.razorpay_payment_link_url or
    new.razorpay_payment_id      is distinct from old.razorpay_payment_id      or
    new.razorpay_refund_id       is distinct from old.razorpay_refund_id       or
    new.refunded_at              is distinct from old.refunded_at
  ) then
    raise exception
      'Only service-role may write Razorpay audit columns on appointments'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_razorpay_columns on public.appointments;
create trigger trg_guard_razorpay_columns
  before update on public.appointments
  for each row execute function public.guard_razorpay_columns();
