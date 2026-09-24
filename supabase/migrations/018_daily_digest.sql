-- Daily end-of-day reconciliation email (app/api/cron/daily-digest) idempotency
-- guard — one row per calendar date (IST) the digest was actually sent for, so
-- a GitHub Actions retry or a second near-boundary trigger never double-sends.
create table if not exists public.daily_digest_sent (
  date date primary key,
  sent_at timestamptz not null default now()
);

-- RLS: deny all for anon/authenticated, service-role only
alter table public.daily_digest_sent enable row level security;
create policy "deny_all_daily_digest_sent" on public.daily_digest_sent for all to authenticated, anon using (false) with check (false);
