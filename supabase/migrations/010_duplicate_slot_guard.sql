-- Same-phone / same-date / same-time duplicate guard (defense-in-depth).
--
-- The application-level check in dbAddBooking is a SELECT-then-INSERT and can
-- race under a double-tap (two concurrent bookings both pass the SELECT, then
-- both INSERT). This partial unique index closes that window: at most one live
-- row per (phone, appt_date, appt_time). Only live rows count — cancelled and
-- done rows let the same slot be rebooked after the visit cycle finishes, and
-- the app-level check mirrors the same status set (reserved, confirmed,
-- waiting, consulting, payment_pending).
--
-- Note on phone shapes: the index sits on the raw column, so it covers the
-- 10-digit canonical form that the site, the WhatsApp Flow, and the
-- conversational bot all store after normalizePhone. A historical row stored
-- with a 91/0 prefix (older conversational-bot bookings) is a different key
-- here and would escape this index; the app-level phoneMatchVariants check in
-- dbAddBooking still catches those. Run the duplicate pre-flight first:
--
--   select phone, appt_date, appt_time, count(*)
--   from appointments
--   where status not in ('cancelled','done') and phone is not null and phone <> ''
--   group by 1, 2, 3 having count(*) > 1;
--
-- and resolve any rows it returns (keep one, cancel/del the rest) before the
-- index will build. dbAddBooking maps a 23505 violation of this index to
-- DuplicateSlotError (the same error the app guard throws).

create unique index appointments_slot_guard
  on public.appointments (phone, appt_date, appt_time)
  where status not in ('cancelled', 'done') and phone is not null and phone <> '';