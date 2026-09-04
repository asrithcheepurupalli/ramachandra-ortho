-- ─────────────────────────────────────────────────────────────────────────────
-- Run this once in the Supabase SQL editor (or `supabase db push`) against the
-- LIVE project. It moves the staff allowlist out of a hardcoded array baked
-- into three RLS policies (and a separately-maintained ADMIN_EMAILS env var
-- in the app) into one table both sides read, so they can't drift apart.
--
-- Safe to run more than once — every statement is idempotent.
-- After this runs, proxy.ts and lib/auth-server.ts (already updated in this
-- deploy) call `supabase.rpc("is_staff", ...)` instead of parsing an env var.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.staff_emails (
  email text primary key
);
insert into public.staff_emails (email) values ('admin@ramachandracare.in')
on conflict (email) do nothing;
alter table public.staff_emails enable row level security;

create or replace function public.is_staff(check_email text)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.staff_emails where email = lower(check_email)
  );
$$;
grant execute on function public.is_staff(text) to anon, authenticated;

drop policy if exists "staff full patients" on public.patients;
create policy "staff full patients" on public.patients for all to authenticated
  using (public.is_staff(auth.jwt() ->> 'email'))
  with check (public.is_staff(auth.jwt() ->> 'email'));

drop policy if exists "staff full appointments" on public.appointments;
create policy "staff full appointments" on public.appointments for all to authenticated
  using (public.is_staff(auth.jwt() ->> 'email'))
  with check (public.is_staff(auth.jwt() ->> 'email'));

drop policy if exists "staff update settings" on public.settings;
create policy "staff update settings" on public.settings for update to authenticated
  using (public.is_staff(auth.jwt() ->> 'email'))
  with check (public.is_staff(auth.jwt() ->> 'email'));
