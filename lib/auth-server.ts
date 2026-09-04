// ─────────────────────────────────────────────────────────────────────────────
// Server-only staff-session check for API routes that mutate clinic data.
// Mirrors proxy.ts's /admin gate: public signup is on, so a valid Supabase
// session alone isn't proof of staff. The allowlist lives in the database
// (public.staff_emails, via the is_staff() function) so this, proxy.ts, and
// the RLS policies in supabase/schema.sql all read the same source instead
// of a hand-synced ADMIN_EMAILS env var.
// ─────────────────────────────────────────────────────────────────────────────
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { SUPA_URL, SUPA_ANON } from "@/lib/supabase";

export async function requireStaff(): Promise<boolean> {
  if (!SUPA_URL || !SUPA_ANON) return false;
  const cookieStore = await cookies();
  const supabase = createServerClient(SUPA_URL, SUPA_ANON, {
    cookies: { getAll: () => cookieStore.getAll(), setAll: () => {} },
  });
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.email) return false;
  const { data } = await supabase.rpc("is_staff", { check_email: user.email });
  return data === true;
}
