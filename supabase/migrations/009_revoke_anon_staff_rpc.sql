-- Revoke anonymous access to staff-checking RPCs. These are only called
-- server-side (lib/auth-server.ts, proxy.ts) via the service-role or
-- authenticated session. Revoking the anon grant prevents unauthenticated
-- visitors from using the PostgREST endpoint to enumerate staff emails.
-- Run once in the Supabase SQL editor. Safe to re-run (IF EXISTS not
-- available for REVOKE; will error if already revoked -- ignore).
REVOKE EXECUTE ON FUNCTION public.is_staff(text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.staff_role(text) FROM anon;
