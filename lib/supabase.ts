import { createBrowserClient } from "@supabase/ssr";

export const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
export const SUPA_ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

// Is the real database configured? When false, the app runs on the mock store.
export const hasSupabase = () => Boolean(SUPA_URL && SUPA_ANON);

// Browser client (anon key) — used by the authenticated admin session and for
// public reads that RLS permits (the schedule).
export const supabaseBrowser = () => createBrowserClient(SUPA_URL, SUPA_ANON);

// The service-role client lives in ./supabase-admin.ts (guarded by the
// "server-only" package) so it can never be pulled into a client bundle.
