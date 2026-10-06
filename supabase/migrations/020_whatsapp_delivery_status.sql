-- 020_whatsapp_delivery_status.sql
-- whatsapp_logs (migration 016) only ever recorded whether Meta's Graph API
-- ACCEPTED our send request ("sent"), never whether the message actually
-- reached the patient's phone. Meta posts a separate delivery-status callback
-- (sent -> delivered -> read, or failed) to the same webhook, and the handler
-- was only console.log-ing it — nothing persisted, and a failed delivery
-- never reached the Bug Desk. On Vercel's Hobby plan those console logs are
-- gone within about an hour, so "did the patient actually get this?" was
-- unanswerable after the fact. That's the actual explanation for a desk
-- report of a confirmation "not sending" when our own send succeeded.
--
-- Additive only: three nullable columns, filled in by a later UPDATE when the
-- status callback arrives (matched on wamid, Meta's per-message id, which we
-- now also capture at send time).

alter table public.whatsapp_logs
  add column if not exists wamid text,
  add column if not exists delivery_status text,   -- latest of: sent | delivered | read | failed
  add column if not exists delivery_error text,     -- Meta's error detail, only set on failed
  add column if not exists delivered_at timestamptz; -- when the latest delivery_status was recorded

create index if not exists whatsapp_logs_wamid_idx on public.whatsapp_logs (wamid) where wamid is not null;
