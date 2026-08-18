-- Sermon Scribe billing.
--
-- Three tables: what each user is entitled to (subscriptions), which Stripe
-- events have already been applied (stripe_events), and Interac e-Transfer
-- payments awaiting manual verification (interac_claims).

create table if not exists public.subscriptions (
  user_id                uuid primary key references auth.users(id) on delete cascade,
  plan                   text not null default 'free' check (plan in ('free', 'pro', 'ministry')),
  status                 text not null default 'active',
  -- How this plan was paid for. Stripe writes only rows it owns, so a manually
  -- granted Interac plan can't be clobbered by a webhook and vice versa.
  source                 text not null default 'stripe' check (source in ('stripe', 'interac', 'manual')),
  stripe_customer_id     text unique,
  stripe_subscription_id text unique,
  current_period_end     timestamptz,
  cancel_at_period_end   boolean not null default false,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

-- The webhook knows the Stripe customer, not the user, so this lookup is on the
-- hot path for every billing event.
create index if not exists subscriptions_stripe_customer_id_idx
  on public.subscriptions (stripe_customer_id);

alter table public.subscriptions enable row level security;

-- Users may read their own billing state and nothing else. There is deliberately
-- no insert or update policy: only the service role writes here, so a
-- compromised browser session cannot promote itself to a paid plan.
drop policy if exists "Users read own subscription" on public.subscriptions;
create policy "Users read own subscription"
  on public.subscriptions for select
  using (auth.uid() = user_id);

-- Idempotency ledger. Stripe retries on any non-2xx and can deliver the same
-- event more than once even on success, so the webhook claims an event id here
-- before doing any work.
create table if not exists public.stripe_events (
  id          text primary key,
  type        text not null,
  received_at timestamptz not null default now()
);

-- RLS on with zero policies = no client access at all. The service role bypasses
-- RLS, which is the only access this table needs.
alter table public.stripe_events enable row level security;

-- Interac e-Transfer claims. The upgrade page currently shows a success banner
-- and prints a receipt without recording anything, so a payment can arrive with
-- no trace on our side beyond the bank email. This is that missing record.
create table if not exists public.interac_claims (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  plan         text not null check (plan in ('pro', 'ministry')),
  amount_cad   numeric(10,2) not null,
  sender_name  text not null,
  sender_email text not null,
  sent_on      date not null,
  reference    text,
  -- Nothing here grants access. A human confirms the money arrived, then sets
  -- the subscription row; until then the claim is just a claim.
  status       text not null default 'pending' check (status in ('pending', 'verified', 'rejected')),
  created_at   timestamptz not null default now()
);

create index if not exists interac_claims_status_idx on public.interac_claims (status);

alter table public.interac_claims enable row level security;

-- A signed-in user may file a claim for themselves and see their own claims.
-- They cannot change one after filing, so status is not theirs to set.
drop policy if exists "Users file own interac claims" on public.interac_claims;
create policy "Users file own interac claims"
  on public.interac_claims for insert
  to authenticated
  with check (auth.uid() = user_id and status = 'pending');

drop policy if exists "Users read own interac claims" on public.interac_claims;
create policy "Users read own interac claims"
  on public.interac_claims for select
  to authenticated
  using (auth.uid() = user_id);

drop trigger if exists subscriptions_touch_updated_at on public.subscriptions;
create trigger subscriptions_touch_updated_at
  before update on public.subscriptions
  for each row execute function public.touch_updated_at();

-- Every new signup starts on the free plan, so the app reads one row for
-- entitlement instead of branching on "row missing means free".
create or replace function public.create_free_subscription()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.subscriptions (user_id)
  values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_subscription on auth.users;
create trigger on_auth_user_created_subscription
  after insert on auth.users
  for each row execute function public.create_free_subscription();

-- Backfill anyone who already exists when this runs.
insert into public.subscriptions (user_id)
select id from auth.users
on conflict (user_id) do nothing;

-- Grant a plan paid for by e-Transfer. Run after the money actually lands:
--   select public.grant_interac_plan('<claim uuid>', 1);
-- Access ends at current_period_end unless renewed, so an unpaid month lapses
-- instead of quietly continuing forever.
create or replace function public.grant_interac_plan(claim_id uuid, months int default 1)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.interac_claims;
begin
  select * into c from public.interac_claims where id = claim_id;
  if not found then
    raise exception 'No interac claim %', claim_id;
  end if;

  update public.interac_claims set status = 'verified' where id = claim_id;

  insert into public.subscriptions (user_id, plan, status, source, current_period_end)
  values (c.user_id, c.plan, 'active', 'interac', now() + (months || ' months')::interval)
  on conflict (user_id) do update set
    plan               = excluded.plan,
    status             = 'active',
    source             = 'interac',
    current_period_end = excluded.current_period_end;
end;
$$;

revoke all on function public.grant_interac_plan(uuid, int) from public, anon, authenticated;
