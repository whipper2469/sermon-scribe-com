-- Sermon Scribe application schema, recreated for the project the app is
-- migrating to. Mirrors the tables as they exist today in the Snapfix project
-- (japlrtlpopefvgkecpif), which is where the live app currently reads and
-- writes them.

create table if not exists public.sermons (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid references auth.users(id) on delete cascade,
  session_id           text,
  title                text not null,
  topic                text,
  scripture            text,
  scripture_reference  text,
  tone                 text,
  length               text,
  category             text,
  tags                 text[],
  outline              jsonb,
  full_text            text,
  notes                text,
  scheduled_date       date,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index if not exists sermons_user_id_idx on public.sermons (user_id);

alter table public.sermons enable row level security;

-- session_id exists because the app let people generate a sermon before
-- signing up. Those rows have a null user_id and no owner to match, so they
-- stay invisible to the API and are reachable only by the service role.
drop policy if exists "Users manage own sermons" on public.sermons;
create policy "Users manage own sermons"
  on public.sermons for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create table if not exists public.sermon_templates (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  description text,
  structure   jsonb,
  example     text,
  created_at  timestamptz not null default now()
);

alter table public.sermon_templates enable row level security;

-- Templates are shared catalogue content, not user data: readable by anyone
-- signed in, writable only by the service role.
drop policy if exists "Signed-in users read templates" on public.sermon_templates;
create policy "Signed-in users read templates"
  on public.sermon_templates for select
  to authenticated
  using (true);

drop trigger if exists sermons_touch_updated_at on public.sermons;
create trigger sermons_touch_updated_at
  before update on public.sermons
  for each row execute function public.touch_updated_at();
