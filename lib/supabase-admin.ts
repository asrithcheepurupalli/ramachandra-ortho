import "server-only";
import { createClient } from "@supabase/supabase-js";
import { SUPA_URL } from "@/lib/supabase";

// Service-role client. The "server-only" import makes it a build error for
// any "use client" component to pull this in, even transitively — the key
// bypasses RLS entirely, so it must never reach the browser bundle.
export const supabaseAdmin = () =>
  createClient(SUPA_URL, process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", {
    auth: { persistSession: false, autoRefreshToken: false },
  });
