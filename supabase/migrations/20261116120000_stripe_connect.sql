-- Stripe Connect V2 demonstration records. Stripe remains the source of truth
-- for onboarding requirements, product prices, and capability state.
create table if not exists public.stripe_connect_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  account_id text not null unique,
  public_slug text not null unique,
  store_name text not null default 'Sermon Scribe seller',
  card_payments_status text,
  requirements_status text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
alter table public.stripe_connect_accounts enable row level security;
drop policy if exists "Users read own Connect account" on public.stripe_connect_accounts;
create policy "Users read own Connect account" on public.stripe_connect_accounts
  for select to authenticated using (auth.uid() = user_id);

-- The thin and snapshot destinations have separate event IDs and idempotency
-- records. Avoid persisting the snapshots, which can contain billing PII.
create table if not exists public.stripe_connect_events (
  id text primary key,
  type text not null,
  account_id text,
  received_at timestamptz not null default now()
);
alter table public.stripe_connect_events enable row level security;

create table if not exists public.stripe_connect_subscriptions (
  stripe_subscription_id text primary key,
  account_id text not null,
  status text not null,
  price_id text,
  cancel_at_period_end boolean not null default false,
  updated_at timestamptz not null default now()
);
alter table public.stripe_connect_subscriptions enable row level security;

create index if not exists stripe_connect_events_account_idx on public.stripe_connect_events(account_id, received_at desc);
create index if not exists stripe_connect_subscriptions_account_idx on public.stripe_connect_subscriptions(account_id);
