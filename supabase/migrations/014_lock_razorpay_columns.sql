-- Prevent any non-service-role session from writing Razorpay-specific audit
-- columns on appointments. All legitimate writes to these columns already go
-- through server API routes (payments webhook, payment-link route, refund
-- route, admin-reschedule route) which use supabaseAdmin() — service_role.
-- Staff browser sessions may write other columns (status, paid/paid_via for
-- cash, notes) but should never touch Razorpay internal IDs or timestamps.
--
-- A BEFORE trigger fires for every role including service_role, so we check
-- auth.role() — the JWT claim set in the Supabase request — and only raise
-- when the caller is *not* service_role and one of the locked columns changed.

create or replace function public.guard_razorpay_columns()
returns trigger
language plpgsql
security definer
as $$
begin
  -- Service-role (used by server API routes via supabaseAdmin()) may write anything.
  if auth.role() = 'service_role' then
    return new;
  end if;

  if (
    new.razorpay_payment_link_id is distinct from old.razorpay_payment_link_id or
    new.razorpay_payment_link_url is distinct from old.razorpay_payment_link_url or
    new.razorpay_payment_id      is distinct from old.razorpay_payment_id      or
    new.razorpay_refund_id       is distinct from old.razorpay_refund_id       or
    new.refunded_at              is distinct from old.refunded_at
  ) then
    raise exception
      'Only service-role may write Razorpay audit columns on appointments'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_guard_razorpay_columns on public.appointments;
create trigger trg_guard_razorpay_columns
  before update on public.appointments
  for each row execute function public.guard_razorpay_columns();
