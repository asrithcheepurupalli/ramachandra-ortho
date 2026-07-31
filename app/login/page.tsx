"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Lock, LogIn } from "lucide-react";
import { clinic } from "@/clinic.config";
import { supabaseBrowser } from "@/lib/supabase";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") || "/admin";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr("");
    const { error } = await supabaseBrowser().auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) { setErr(error.message); return; }
    router.replace(next);
    router.refresh();
  };

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center px-5 py-12">
      <div className="rounded-3xl border border-line bg-surface p-7 shadow-lift">
        <span className="grid h-12 w-12 place-items-center rounded-2xl bg-brand text-white"><Lock className="h-6 w-6" /></span>
        <h1 className="mt-5 text-2xl font-semibold">Clinic admin</h1>
        <p className="mt-1 text-sm text-muted">Sign in to manage {clinic.shortName}.</p>
        <form onSubmit={submit} className="mt-6 space-y-3">
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" autoComplete="email" className="w-full rounded-xl border border-line bg-bg px-4 py-3 text-[15px] outline-none focus:border-brand focus:bg-surface" />
          <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" autoComplete="current-password" className="w-full rounded-xl border border-line bg-bg px-4 py-3 text-[15px] outline-none focus:border-brand focus:bg-surface" />
          {err && <p className="text-sm text-out">{err}</p>}
          <button disabled={busy} className="press flex w-full items-center justify-center gap-2 rounded-full bg-brand py-3 text-sm font-semibold text-white transition hover:bg-brand-dark disabled:opacity-60">
            <LogIn className="h-4 w-4" /> {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
