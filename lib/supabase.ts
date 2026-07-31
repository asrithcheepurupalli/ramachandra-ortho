import { createBrowserClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";

export const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
export const SUPA_ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

// Is the real database configured? When false, the app runs on the mock store.
export const hasSupabase = () => Boolean(SUPA_URL && SUPA_ANON);

// Browser client (anon key) — used by the authenticated admin session and for
// public reads that RLS permits (the schedule).
export const supabaseBrowser = () => createBrowserClient(SUPA_URL, SUPA_ANON);

// Server-only client with the service_role key. NEVER import into client code.
// Used by /api routes to mediate public booking without exposing patient data.
export const supabaseAdmin = () =>
  createClient(SUPA_URL, process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", {
    auth: { persistSession: false, autoRefreshToken: false },
  });
