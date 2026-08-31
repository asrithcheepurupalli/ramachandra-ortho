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

-- Clinic settings: schedule + override live in one row ─────────────────────────
create table if not exists public.settings (
  id          int primary key default 1 check (id = 1),
  weekly      jsonb not null,
  exceptions  jsonb not null default '{}'::jsonb,
  override    jsonb,
  updated_at  timestamptz not null default now()
);

-- seed the schedule the app already uses (Mon-Sat 10:00-12:30 & 18:00-20:00, Sun holiday)
insert into public.settings (id, weekly) values (1, '{
  "0": [],
  "1": [{"start":"10:00","end":"12:30"},{"start":"18:00","end":"20:00"}],
  "2": [{"start":"10:00","end":"12:30"},{"start":"18:00","end":"20:00"}],
  "3": [{"start":"10:00","end":"12:30"},{"start":"18:00","end":"20:00"}],
  "4": [{"start":"10:00","end":"12:30"},{"start":"18:00","end":"20:00"}],
  "5": [{"start":"10:00","end":"12:30"},{"start":"18:00","end":"20:00"}],
  "6": [{"start":"10:00","end":"12:30"},{"start":"18:00","end":"20:00"}]
}'::jsonb)
on conflict (id) do nothing;

-- Row Level Security ─────────────────────────────────────────────────────────
-- Patient data is never exposed to anonymous visitors. Public booking + slot
-- availability go through server API routes using the service_role key, which
-- bypasses RLS. Staff use an authenticated session with full access.
alter table public.patients      enable row level security;
alter table public.appointments  enable row level security;
alter table public.settings      enable row level security;

-- staff (logged in) can do everything with patients + appointments
create policy "staff full patients"     on public.patients     for all to authenticated using (true) with check (true);
create policy "staff full appointments" on public.appointments for all to authenticated using (true) with check (true);

-- schedule/hours are safe to read publicly (drives the site banner); only staff edit
create policy "public read settings"    on public.settings     for select to anon, authenticated using (true);
create policy "staff update settings"   on public.settings     for update to authenticated using (true) with check (true);

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
  updated_at  timestamptz not null default now()
);
alter table public.wa_sessions enable row level security;
