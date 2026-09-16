-- Add locality column to appointments (patient's neighbourhood / area, e.g. "MVP Colony").
-- Optional: some bookings (walk-ins, older records) will have null.
alter table public.appointments add column if not exists locality text;
