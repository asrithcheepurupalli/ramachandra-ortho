-- 019_cancel_audit.sql
-- Append-only record of every staff cancel from the admin screen: when it was
-- pressed, which staff login and device did it, what the appointment looked
-- like at that moment, and whether the cancel also issued an automatic
-- Razorpay refund. Added after three paid bookings were cancelled and
-- auto-refunded on 2026-10-03 with no way to tell who or from where, because
-- every desk device shares one login.
--
-- Additive only: a new table, no change to appointments. Service-role access
-- only (the API route writes it; nothing in the browser reads or writes it).
-- No retention pruning: these rows are tiny and are the paper trail for money.

create table if not exists public.cancel_audit (
  id              uuid primary key default gen_random_uuid(),
  appointment_id  uuid not null,
  token           integer,
  patient_name    text,
  phone           text,
  appt_date       text,
  appt_time       text,
  prev_status     text,            -- status the row had just before the cancel
  fee             integer,
  paid            boolean,
  paid_via        text,            -- 'razorpay' | 'cash' | null
  refund_issued   boolean not null default false,  -- true if THIS cancel auto-refunded
  refund_id       text,
  refund_error    text,            -- set when an auto-refund was attempted and failed
  staff_email     text,            -- the shared desk login; same for every device
  ip              text,
  user_agent      text,            -- the only thing that tells desk devices apart
  created_at      timestamptz not null default now()
);

create index if not exists cancel_audit_created_at_idx on public.cancel_audit (created_at desc);
create index if not exists cancel_audit_appointment_idx on public.cancel_audit (appointment_id);

alter table public.cancel_audit enable row level security;
create policy "deny_all_cancel_audit" on public.cancel_audit
  for all to authenticated, anon
  using (false)
  with check (false);
