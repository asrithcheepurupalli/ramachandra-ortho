"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Lock, LogIn } from "lucide-react";
import { clinic } from "@/clinic.config";
import { supabaseBrowser } from "@/lib/supabase";

// Client-side lockout against a scripted password guesser hammering this
// form — Supabase's own auth rate limits are the real backstop, but they're
// per-project (not tuned to this one login form), so this gives an
// immediate, visible cutoff after repeated failures instead of letting the
// browser fire an unbounded stream of signInWithPassword calls.
const ATTEMPTS_KEY = "rc_admin_login_attempts";
const MAX_ATTEMPTS = 5;
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const LOCKOUT_MS = 5 * 60 * 1000;

function recentAttempts(): number[] {
  try {
    const raw = localStorage.getItem(ATTEMPTS_KEY);
    const all = raw ? (JSON.parse(raw) as number[]) : [];
    return all.filter((t) => Date.now() - t < ATTEMPT_WINDOW_MS);
  } catch {
    return [];
  }
}
function recordFailedAttempt() {
  try {
    localStorage.setItem(ATTEMPTS_KEY, JSON.stringify([...recentAttempts(), Date.now()]));
  } catch {}
}
function clearAttempts() {
  try { localStorage.removeItem(ATTEMPTS_KEY); } catch {}
}
function lockedUntil(): number | null {
  const attempts = recentAttempts();
  if (attempts.length < MAX_ATTEMPTS) return null;
  const until = attempts[attempts.length - 1] + LOCKOUT_MS;
  return until > Date.now() ? until : null;
}
function lockedMsg(until: number): string {
  return `Too many failed attempts. Try again in ${Math.max(1, Math.ceil((until - Date.now()) / 60_000))} min.`;
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") || "/admin";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [lockUntil, setLockUntil] = useState<number | null>(() => lockedUntil());
  const [err, setErr] = useState<string>(() => {
    const l = lockedUntil();
    return l ? lockedMsg(l) : "";
  });
  const [busy, setBusy] = useState(false);
  const isLocked = lockUntil !== null;

  // Auto-clear the lock once its window elapses, so the button re-enables on
  // its own instead of staying disabled until the next submit attempt.
  useEffect(() => {
    if (lockUntil === null) return;
    const t = setTimeout(() => setLockUntil(null), Math.max(0, lockUntil - Date.now()));
    return () => clearTimeout(t);
  }, [lockUntil]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const stillLocked = lockedUntil();
    if (stillLocked) { setLockUntil(stillLocked); setErr(lockedMsg(stillLocked)); return; }

    setBusy(true); setErr("");
    const { error } = await supabaseBrowser().auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) {
      recordFailedAttempt();
      const nowLocked = lockedUntil();
      if (nowLocked) { setLockUntil(nowLocked); setErr(lockedMsg(nowLocked)); }
      else setErr(error.message);
      return;
    }
    clearAttempts();
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
          <button disabled={busy || isLocked} className="press flex w-full items-center justify-center gap-2 rounded-full bg-brand py-3 text-sm font-semibold text-white transition hover:bg-brand-dark disabled:opacity-60">
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
