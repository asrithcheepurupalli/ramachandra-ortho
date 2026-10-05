// ─────────────────────────────────────────────────────────────────────────────
// Server-only staff-session check for API routes that mutate clinic data.
// Mirrors proxy.ts's /admin gate: public signup is on, so a valid Supabase
// session alone isn't proof of staff. The allowlist lives in the database
// (public.staff_emails, via the is_staff() function) so this, proxy.ts, and
// the RLS policies in supabase/schema.sql all read the same source. There
// used to be a separate ADMIN_EMAILS env var for this; it was removed once
// staff_emails/is_staff() replaced it and no longer exists anywhere.
// ─────────────────────────────────────────────────────────────────────────────
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { SUPA_URL, SUPA_ANON } from "@/lib/supabase";

// The signed-in staff member's email, or null when not signed in / not staff.
// Same gate as requireStaff, but hands back who it was for audit trails.
export async function requireStaffEmail(): Promise<string | null> {
  if (!SUPA_URL || !SUPA_ANON) return null;
  const cookieStore = await cookies();
  const supabase = createServerClient(SUPA_URL, SUPA_ANON, {
    cookies: { getAll: () => cookieStore.getAll(), setAll: () => {} },
  });
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.email) return null;
  const { data } = await supabase.rpc("is_staff", { check_email: user.email });
  return data === true ? user.email : null;
}

export async function requireStaff(): Promise<boolean> {
  return (await requireStaffEmail()) !== null;
}

// Which portal (/admin vs /doctor) the signed-in staff email should land on.
// Null covers both "not signed in" and "not staff" — callers treat that the
// same as the 'staff' default rather than distinguishing the two.
export async function getStaffRole(): Promise<string | null> {
  if (!SUPA_URL || !SUPA_ANON) return null;
  const cookieStore = await cookies();
  const supabase = createServerClient(SUPA_URL, SUPA_ANON, {
    cookies: { getAll: () => cookieStore.getAll(), setAll: () => {} },
  });
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.email) return null;
  const { data } = await supabase.rpc("staff_role", { check_email: user.email });
  return typeof data === "string" ? data : null;
}
