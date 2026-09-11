-- Revoke anonymous access to staff-checking RPCs. These are only called
-- server-side (lib/auth-server.ts, proxy.ts) via the service-role or
-- authenticated session. Revoking the anon grant prevents unauthenticated
-- visitors from using the PostgREST endpoint to enumerate staff emails.
--
-- IMPORTANT: Postgres grants EXECUTE to PUBLIC by default on CREATE FUNCTION,
-- so revoking from `anon` alone is NOT enough — anon inherits through PUBLIC.
-- The PUBLIC revoke below is the actual fix; the anon revokes are kept for
-- explicitness (and for projects where a narrower grant already removed PUBLIC).
-- Verified in production: with ONLY the anon revokes applied, anonymous calls
-- still returned 200; after the PUBLIC revokes they return 401.
--
-- Run once in the Supabase SQL editor. Safe to re-run (IF EXISTS not
-- available for REVOKE; will error if already revoked -- ignore).
REVOKE EXECUTE ON FUNCTION public.is_staff(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.staff_role(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.is_staff(text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.staff_role(text) FROM anon;