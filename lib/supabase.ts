import { createBrowserClient } from "@supabase/ssr";

export const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
export const SUPA_ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

// Is the real database configured? When false, the app runs on the mock store.
export const hasSupabase = () => Boolean(SUPA_URL && SUPA_ANON);

// Browser client (anon key) — used by the authenticated admin session and for
// public reads that RLS permits (the schedule).
// Pass { remember: true } at login time to store auth cookies with a 30-day
// maxAge so the session survives browser restarts.
export const supabaseBrowser = (opts?: { remember?: boolean }) =>
  createBrowserClient(SUPA_URL, SUPA_ANON,
    opts?.remember ? { cookieOptions: { maxAge: 60 * 60 * 24 * 30 } } : undefined
  );

// The service-role client lives in ./supabase-admin.ts (guarded by the
// "server-only" package) so it can never be pulled into a client bundle.
