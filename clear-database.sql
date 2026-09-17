-- ============================================================================
-- RAMACHANDRA ORTHO CARE -- PRODUCTION GO-LIVE PURGE SCRIPT
-- ============================================================================
-- Run this in Supabase SQL Editor immediately prior to go-live.
-- Clears all test patient data, appointments, sessions, and test logs.
-- Preserves settings (clinic schedule/overrides) and staff_emails (admin access).
-- Starts real patient codes from PT29500.
-- ============================================================================

-- 1. Wipe test transaction & patient data
TRUNCATE TABLE public.appointments CASCADE;
TRUNCATE TABLE public.patients CASCADE;
TRUNCATE TABLE public.wa_sessions;

-- 2. Wipe rate limits, OTP challenges, and test logging
TRUNCATE TABLE public.rate_limits;
TRUNCATE TABLE public.otp_challenges;
TRUNCATE TABLE public.error_logs;
TRUNCATE TABLE public.doctor_digest_sent;
TRUNCATE TABLE public.session_digest_sent;
TRUNCATE TABLE public.whatsapp_logs;

-- 3. Restart sequence so first real patient receives PT29500
ALTER SEQUENCE IF EXISTS patient_code_seq RESTART WITH 29500;
