import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

// Supabase signup is open to the public — a valid session alone doesn't mean
// staff. The allowlist lives in the database (public.staff_emails, checked
// via the is_staff() function) instead of an env var, so this and the RLS
// policies in supabase/schema.sql can never drift apart. There used to be a
// separate ADMIN_EMAILS env var for this; it was removed once staff_emails/
// is_staff() replaced it and no longer exists anywhere.
async function isStaff(
  supabase: ReturnType<typeof createServerClient>,
  email?: string | null
): Promise<boolean> {
  if (!email) return false;
  const { data } = await supabase.rpc("is_staff", { check_email: email });
  return data === true;
}

// Which portal a staff email lands on — purely routing, not an access check.
async function staffRole(
  supabase: ReturnType<typeof createServerClient>,
  email?: string | null
): Promise<string> {
  if (!email) return "staff";
  const { data } = await supabase.rpc("staff_role", { check_email: email });
  return typeof data === "string" && data ? data : "staff";
}

export async function proxy(req: NextRequest) {
  const reqHeaders = new Headers(req.headers);

  // If the DB isn't configured (mock mode), skip auth gating.
  if (!URL || !ANON) {
    return NextResponse.next({ request: { headers: reqHeaders } });
  }

  let res = NextResponse.next({ request: { headers: reqHeaders } });
  const supabase = createServerClient(URL, ANON, {
    cookies: {
      getAll: () => req.cookies.getAll(),
      setAll: (list) => {
        list.forEach(({ name, value }) => req.cookies.set(name, value));
        res = NextResponse.next({ request: { headers: reqHeaders } });
        list.forEach(({ name, value, options }) => res.cookies.set(name, value, options));
      },
    },
  });

  const { data: { user } } = await supabase.auth.getUser();

  const path = req.nextUrl.pathname;
  const isPortal = path.startsWith("/admin") || path.startsWith("/doctor");

  if (isPortal && !(await isStaff(supabase, user?.email))) {
    if (user) await supabase.auth.signOut();
    const to = req.nextUrl.clone();
    to.pathname = "/login";
    to.searchParams.set("next", req.nextUrl.pathname);
    return NextResponse.redirect(to);
  }
  // Staff opening the PWA (start_url "/") or the homepage should land on their
  // dashboard, not the patient-facing site.
  if ((path === "/" || path === "/login") && (await isStaff(supabase, user?.email))) {
    const to = req.nextUrl.clone();
    to.pathname = (await staffRole(supabase, user?.email)) === "doctor" ? "/doctor" : "/admin";
    to.search = "";
    return NextResponse.redirect(to);
  }

  return res;
}

// Cover all page routes (skip API routes, static/image assets, and favicon
// so those don't needlessly run proxy). Also skip prefetch requests.
export const config = {
  matcher: [
    {
      source: "/((?!api|_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
