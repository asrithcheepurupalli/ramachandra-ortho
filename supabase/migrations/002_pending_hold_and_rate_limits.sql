-- ─────────────────────────────────────────────────────────────────────────────
-- Run this once in the Supabase SQL editor (or `supabase db push`) against the
-- LIVE project. Safe to run more than once — every statement is idempotent.
--
-- 1. Closes a check-then-act race in dbAddBooking (lib/db.ts): the existing
--    "does this phone already have a payment_pending hold?" check is a plain
--    SELECT before the INSERT, so two concurrent booking attempts for the
--    same phone (double-tap, two devices, a retried request) can both pass
--    the check and both insert a payment_pending row — two held slots on one
--    unpaid phone. This partial unique index makes Postgres itself refuse the
--    second row; dbAddBooking catches the resulting 23505 and throws the same
--    PendingHoldError it already throws from the application-level check
--    (kept as a fast pre-check — this index is the real guard).
--
-- 2. Backs the DB-shared rate limiter in lib/rate-limit.ts, used by
--    /api/patients/lookup (and /api/book) so throttling isn't per-instance
--    only — a limit reset by simply hitting a different serverless instance
--    would be no limit at all.
-- ─────────────────────────────────────────────────────────────────────────────

create unique index if not exists appointments_pending_hold_idx
  on public.appointments (phone)
  where status = 'payment_pending' and phone is not null and phone <> '';

create table if not exists public.rate_limits (
  key text primary key,
  count integer not null default 1,
  window_start timestamptz not null default now()
);
alter table public.rate_limits enable row level security;

-- Service-role only (the app's admin client bypasses RLS entirely; this
-- policy just keeps the table inaccessible to anon/authenticated clients).
drop policy if exists "no client access rate_limits" on public.rate_limits;
create policy "no client access rate_limits" on public.rate_limits for all to authenticated, anon
  using (false) with check (false);
