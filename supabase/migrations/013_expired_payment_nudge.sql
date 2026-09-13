-- Payment-expiry re-nudge (app/api/cron/payment-timeout): two columns that
-- power "your payment link expired" WhatsApp nudge + one-tap resume.
--
-- cancel_reason: sets 'payment_timeout' on a row exactly when it is cancelled
-- BECAUSE the 15-minute payment window lapsed without payment (the timeout
-- cron or the lazy expiry in lib/db.ts). Every other cancellation — staff,
-- admin, the booking flow's "Start fresh" (replacePending) — leaves it NULL.
-- This asymmetry is the only thing that keeps the resume path from ever
-- resurrecting a deliberately-cancelled booking.
--
-- expired_payment_nudged_at: the instant the post-expiry WhatsApp nudge was
-- sent for a (whatsapp-source) row. NULL = not yet nudged; the cron's
-- idempotency guard is a conditional update on this being NULL, so a patient
-- whose payment link expired is nudged exactly once (and a failed send is
-- rolled back so the next tick retries within Meta's 24h window).
alter table public.appointments add column if not exists cancel_reason text;
alter table public.appointments add column if not exists expired_payment_nudged_at timestamptz;