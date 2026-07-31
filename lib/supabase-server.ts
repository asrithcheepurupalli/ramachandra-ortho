import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { SUPA_URL, SUPA_ANON } from "@/lib/supabase";

// Cookie-bound server client for Server Components / Route Handlers, so the
// staff session (and RLS role) flows through on the server.
export async function supabaseServer() {
  const cookieStore = await cookies();
  return createServerClient(SUPA_URL, SUPA_ANON, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (list) => {
        try {
          list.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // called from a Server Component — safe to ignore, middleware refreshes
        }
      },
    },
  });
}
