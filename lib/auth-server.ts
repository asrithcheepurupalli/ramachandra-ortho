// ─────────────────────────────────────────────────────────────────────────────
// Server-only staff-session check for API routes that mutate clinic data.
// Mirrors proxy.ts's /admin gate: public signup is on, so a valid Supabase
// session alone isn't proof of staff — only these emails may write.
// ─────────────────────────────────────────────────────────────────────────────
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { SUPA_URL, SUPA_ANON } from "@/lib/supabase";

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS ?? "")
  .split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);

export async function requireStaff(): Promise<boolean> {
  if (!SUPA_URL || !SUPA_ANON) return false;
  const cookieStore = await cookies();
  const supabase = createServerClient(SUPA_URL, SUPA_ANON, {
    cookies: { getAll: () => cookieStore.getAll(), setAll: () => {} },
  });
  const { data: { user } } = await supabase.auth.getUser();
  return !!user?.email && ADMIN_EMAILS.includes(user.email.toLowerCase());
}
