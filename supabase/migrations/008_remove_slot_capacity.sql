-- Remove the one-booking-per-slot capacity limit. Any number of patients may
-- now share the same date+time slot. The grey-out UI and per-slot taken-slot
-- lookups are removed at the application level; this migration drops only the
-- database constraint that enforced the cap.
drop index if exists public.appointments_slot_idx;
