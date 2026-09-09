-- Add age column to appointments table
alter table public.appointments add column if not exists age int;

-- Create session_digest_sent table for cron idempotency (one digest per window per day)
create table if not exists public.session_digest_sent (
  date date not null,
  window_start text not null,
  primary key (date, window_start)
);

-- RLS: deny all for anon/authenticated, service-role only
alter table public.session_digest_sent enable row level security;
create policy "deny_all_session_digest_sent" on public.session_digest_sent for all to authenticated, anon using (false) with check (false);
