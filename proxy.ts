import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

// Supabase signup is open to the public — a valid session alone doesn't mean
// staff. The allowlist lives in the database (public.staff_emails, checked
// via the is_staff() function) instead of an env var, so this and the RLS
// policies in supabase/schema.sql can never drift apart the way a
// hand-synced ADMIN_EMAILS env var and a hardcoded SQL array could.
async function isStaff(
  supabase: ReturnType<typeof createServerClient>,
  email?: string | null
): Promise<boolean> {
  if (!email) return false;
  const { data } = await supabase.rpc("is_staff", { check_email: email });
  return data === true;
}

export async function proxy(req: NextRequest) {
  // If the DB isn't configured (mock mode), don't gate anything.
  if (!URL || !ANON) return NextResponse.next();

  let res = NextResponse.next({ request: req });
  const supabase = createServerClient(URL, ANON, {
    cookies: {
      getAll: () => req.cookies.getAll(),
      setAll: (list) => {
        list.forEach(({ name, value }) => req.cookies.set(name, value));
        res = NextResponse.next({ request: req });
        list.forEach(({ name, value, options }) => res.cookies.set(name, value, options));
      },
    },
  });

  const { data: { user } } = await supabase.auth.getUser();

  // Lock the dashboard; bounce logged-out (or non-staff) users to /login.
  if (req.nextUrl.pathname.startsWith("/admin") && !(await isStaff(supabase, user?.email))) {
    if (user) await supabase.auth.signOut(); // logged in but not staff — don't leave a dangling session
    const to = req.nextUrl.clone();
    to.pathname = "/login";
    to.searchParams.set("next", req.nextUrl.pathname);
    return NextResponse.redirect(to);
  }
  // Already signed in as staff? Skip the login page.
  if (req.nextUrl.pathname === "/login" && (await isStaff(supabase, user?.email))) {
    const to = req.nextUrl.clone();
    to.pathname = "/admin";
    return NextResponse.redirect(to);
  }
  return res;
}

export const config = { matcher: ["/admin/:path*", "/login"] };
