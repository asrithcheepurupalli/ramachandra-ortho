-- 016_whatsapp_logs.sql
-- Outgoing WhatsApp message logs for staff audit, delivery tracking, and verification.
-- Records template triggers, bot interactive/text replies, OTPs, reminders, broadcasts, etc.
-- 7-day retention policy (auto-pruned). Service-role only access.

create table if not exists public.whatsapp_logs (
  id             uuid primary key default gen_random_uuid(),
  phone          text not null,
  patient_name   text,
  message_type   text not null default 'template', -- 'template' | 'text' | 'interactive'
  template_name  text,
  status         text not null default 'sent',     -- 'sent' | 'failed' | 'skipped'
  details        text,
  error_message  text,
  created_at     timestamptz not null default now()
);

create index if not exists whatsapp_logs_created_at_idx on public.whatsapp_logs (created_at desc);
create index if not exists whatsapp_logs_phone_idx on public.whatsapp_logs (phone);

alter table public.whatsapp_logs enable row level security;
create policy "deny_all_whatsapp_logs" on public.whatsapp_logs
  for all to authenticated, anon
  using (false)
  with check (false);
