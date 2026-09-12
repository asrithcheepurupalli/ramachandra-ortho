-- Post-visit review nudge (app/api/cron/review-nudge): the instant the automatic
-- "how was your visit? leave a Google review" nudge was sent (same day, 3h after
-- the slot, once status = done). NULL = not yet nudged; the cron's idempotency
-- guard is a conditional update on this being NULL, so a visit is nudged once.
alter table public.appointments add column if not exists review_nudge_sent_at timestamptz;