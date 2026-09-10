alter table public.appointments add column if not exists gender text check (gender in ('M', 'F'));
