-- Free-review-visit nudge (app/api/cron/free-visit-nudge): the instant the
-- automatic "you have a free follow-up review visit within 10 days, book it"
-- nudge was sent for a consultation appointment. NULL = not yet nudged; the
-- cron's idempotency guard is a conditional update on this being NULL, so a
-- patient who consulted (and hasn't booked their free review) is nudged once.
alter table public.appointments add column if not exists free_visit_reminder_sent_at timestamptz;