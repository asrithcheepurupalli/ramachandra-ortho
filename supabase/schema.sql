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
  created_at  timestamptz not null default now()
);
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
  status      text not null default 'reserved',  -- reserved|confirmed|waiting|consulting|done|cancelled
  source      text not null default 'website',   -- website|whatsapp|walkin
  fee         int  not null,
  paid        boolean not null default false,
  created_at  timestamptz not null default now(),
  unique (appt_date, token)
);
create index if not exists appointments_date_idx on public.appointments (appt_date);
-- Real double-booking guard: two active (non-cancelled) appointments can never
-- share a date+time, even under concurrent inserts. A cancelled slot frees up
-- (partial index only covers status <> 'cancelled'), and dbAddBooking retries
-- with a fresh token on a plain token collision, but surfaces this violation
-- to the caller as SlotTakenError.
create unique index if not exists appointments_slot_idx on public.appointments (appt_date, appt_time) where status <> 'cancelled';

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
-- all read this instead of each keeping their own copy (a hardcoded SQL array
-- here plus an ADMIN_EMAILS env var in the app, synced only by a code comment).
create table if not exists public.staff_emails (
  email text primary key
);
insert into public.staff_emails (email) values ('admin@ramachandracare.in')
on conflict (email) do nothing;
alter table public.staff_emails enable row level security;
-- No select policy: nothing reads this table directly (not even staff via
-- PostgREST) — only is_staff() below does, and security definer lets it see
-- the table's rows regardless of RLS.

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
grant execute on function public.is_staff(text) to anon, authenticated;

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
