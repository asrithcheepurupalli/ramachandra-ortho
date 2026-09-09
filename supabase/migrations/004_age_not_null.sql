-- Make age required on all appointments.
-- Backfills null / out-of-range values to 0, then enforces NOT NULL + range.

-- 1. Backfill: any NULL or out-of-range age becomes 0 (sentinel for "not collected").
update public.appointments
   set age = 0
 where age is null
    or age < 0
    or age > 150;

-- 2. Enforce NOT NULL.
alter table public.appointments
  alter column age set not null;

-- 3. Range check: age must be between 0 and 150.
alter table public.appointments
  add constraint appointments_age_check
  check (age between 0 and 150);
