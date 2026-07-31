import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

export async function middleware(req: NextRequest) {
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

  // Lock the dashboard; bounce logged-out users to /login (remember where they were).
  if (req.nextUrl.pathname.startsWith("/admin") && !user) {
    const to = req.nextUrl.clone();
    to.pathname = "/login";
    to.searchParams.set("next", req.nextUrl.pathname);
    return NextResponse.redirect(to);
  }
  // Already signed in? Skip the login page.
  if (req.nextUrl.pathname === "/login" && user) {
    const to = req.nextUrl.clone();
    to.pathname = "/admin";
    return NextResponse.redirect(to);
  }
  return res;
}

export const config = { matcher: ["/admin/:path*", "/login"] };
