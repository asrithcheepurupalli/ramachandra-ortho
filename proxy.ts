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

function buildCsp(nonce: string): string {
  const isDev = process.env.NODE_ENV === "development";
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  return [
    "default-src 'self'",
    // strict-dynamic + nonce: Next.js attaches the nonce to its own inline
    // bootstrap scripts automatically when it finds 'nonce-{value}' in the
    // script-src. No external script tags are used — payment is a redirect,
    // all JS is bundled. unsafe-eval only in dev (React error overlays).
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    // Tailwind and component inline-style props: keeping unsafe-inline on
    // style-src is common and doesn't expose script execution.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    // connect-src covers client-side fetch (Supabase realtime + REST).
    // Razorpay calls are all server-side; payment redirect is navigation.
    `connect-src 'self'${supabaseUrl ? ` ${supabaseUrl}` : ""}`,
    "object-src 'none'",
    "base-uri 'self'",
    // frame-ancestors duplicates X-Frame-Options: DENY but CSP wins in
    // modern browsers.
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
}

export async function proxy(req: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = buildCsp(nonce);

  // Always attach nonce to request headers so Next.js can pick it up for its
  // own inline script tags during server rendering.
  const reqHeaders = new Headers(req.headers);
  reqHeaders.set("x-nonce", nonce);
  reqHeaders.set("Content-Security-Policy", csp);

  // If the DB isn't configured (mock mode), skip auth gating; still set CSP.
  if (!URL || !ANON) {
    const res = NextResponse.next({ request: { headers: reqHeaders } });
    res.headers.set("Content-Security-Policy", csp);
    return res;
  }

  let res = NextResponse.next({ request: { headers: reqHeaders } });
  const supabase = createServerClient(URL, ANON, {
    cookies: {
      getAll: () => req.cookies.getAll(),
      setAll: (list) => {
        list.forEach(({ name, value }) => req.cookies.set(name, value));
        // Supabase may create a new response to write cookies; carry CSP forward.
        res = NextResponse.next({ request: { headers: reqHeaders } });
        list.forEach(({ name, value, options }) => res.cookies.set(name, value, options));
      },
    },
  });

  const { data: { user } } = await supabase.auth.getUser();

  const path = req.nextUrl.pathname;
  const isPortal = path.startsWith("/admin") || path.startsWith("/doctor");

  // Lock both portals; bounce logged-out (or non-staff) users to /login.
  // Either staff email can reach either portal — a two-person clinic isn't
  // worth a hard role wall — this only decides where /login sends you by
  // default, not who's allowed in.
  if (isPortal && !(await isStaff(supabase, user?.email))) {
    if (user) await supabase.auth.signOut(); // logged in but not staff — don't leave a dangling session
    const to = req.nextUrl.clone();
    to.pathname = "/login";
    to.searchParams.set("next", req.nextUrl.pathname);
    const redirect = NextResponse.redirect(to);
    redirect.headers.set("Content-Security-Policy", csp);
    return redirect;
  }
  // Already signed in as staff? Skip the login page, straight to their portal.
  if (path === "/login" && (await isStaff(supabase, user?.email))) {
    const to = req.nextUrl.clone();
    to.pathname = (await staffRole(supabase, user?.email)) === "doctor" ? "/doctor" : "/admin";
    const redirect = NextResponse.redirect(to);
    redirect.headers.set("Content-Security-Policy", csp);
    return redirect;
  }

  res.headers.set("Content-Security-Policy", csp);
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
