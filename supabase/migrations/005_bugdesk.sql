-- ─────────────────────────────────────────────────────────────────────────────
-- Bug desk: error/alert log. Backs lib/bugdesk.ts — every report() either
-- inserts a new fingerprint row (source + message) or bumps its occurrence
-- counter, so a crash-loop or webhook storm accumulates as `count` instead of
-- flooding the table. CRITICAL errors trigger an immediate email alert
-- (throttled by lib/rate-limit.ts); WARNING errors queue for the bugdesk
-- digest cron. Service-role only — the admin page reads it through the
-- staff-gated /api/admin/bugdesk route, never directly.
--
-- Run once in the Supabase SQL editor (live project). Safe to re-run — every
-- statement is idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.error_logs (
  fingerprint     text primary key,       -- sha256(source || message) truncated, lib/bugdesk.ts
  source          text not null,          -- "payments/webhook", "bot", "cron/..."
  message         text not null,
  severity        text not null default 'warning'
                  check (severity in ('critical', 'warning')),
  info            jsonb,                  -- context: ids, amounts, phone, etc.
  count           integer not null default 1,
  first_seen      timestamptz not null default now(),
  last_seen       timestamptz not null default now(),
  alerted_at      timestamptz,            -- immediate critical alert emailed
  digest_sent_at  timestamptz,            -- digest email covered this row
  resolved        boolean not null default false
);

create index if not exists error_logs_last_seen_idx on public.error_logs (last_seen desc);
create index if not exists error_logs_pending_digest_idx on public.error_logs (digest_sent_at)
  where digest_sent_at is null;

-- RLS: deny all for anon/authenticated, service-role only
alter table public.error_logs enable row level security;
create policy "deny_all_error_logs" on public.error_logs for all to authenticated, anon using (false) with check (false);