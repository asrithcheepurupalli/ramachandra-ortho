-- Self-declared payment-exemption claims: a patient can self-declare "returning,
-- pay at counter" or "free review visit" at booking time (no old-patient data
-- exists to verify against, per the clinic's no-import/no-storage constraint —
-- staff verify in person). This flag is about THIS appointment only, not a
-- record of patient history.
alter table public.appointments add column if not exists claim_type text
  check (claim_type in ('returning_unverified', 'review_free'));
