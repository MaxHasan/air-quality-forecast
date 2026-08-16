-- ============================================================================
-- 0003_rls.sql — row-level security.
--
-- Threat model: the anon key ships inside the PWA's JavaScript bundle, so it is
-- public. It must be able to read everything the dashboard displays and nothing
-- else. All writes go through the service-role key, which lives only in GitHub
-- Actions secrets and bypasses RLS entirely — so no write policy is ever
-- needed, and creating one would be a bug.
--
-- v1 has no auth; `authenticated` is granted the same read access as `anon` so
-- that adding sign-in later does not silently break the pages.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Enable RLS everywhere. With RLS on and no policy, a role sees nothing.
-- ---------------------------------------------------------------------------
alter table public.locations            enable row level security;
alter table public.stations             enable row level security;
alter table public.aq_observations      enable row level security;
alter table public.weather_observations enable row level security;
alter table public.daily_aq             enable row level security;
alter table public.daily_weather        enable row level security;
alter table public.model_coefficients   enable row level security;
alter table public.predictions          enable row level security;
alter table public.ingestion_runs       enable row level security;
alter table public.push_subscriptions   enable row level security;

-- ---------------------------------------------------------------------------
-- 2. Public read policies on the display tables.
--    Deliberately absent: push_subscriptions (endpoints are personal data).
-- ---------------------------------------------------------------------------
drop policy if exists "public read locations"            on public.locations;
create policy "public read locations"            on public.locations            for select to anon, authenticated using (true);

drop policy if exists "public read stations"             on public.stations;
create policy "public read stations"             on public.stations             for select to anon, authenticated using (true);

drop policy if exists "public read aq_observations"      on public.aq_observations;
create policy "public read aq_observations"      on public.aq_observations      for select to anon, authenticated using (true);

drop policy if exists "public read weather_observations" on public.weather_observations;
create policy "public read weather_observations" on public.weather_observations for select to anon, authenticated using (true);

drop policy if exists "public read daily_aq"             on public.daily_aq;
create policy "public read daily_aq"             on public.daily_aq             for select to anon, authenticated using (true);

drop policy if exists "public read daily_weather"        on public.daily_weather;
create policy "public read daily_weather"        on public.daily_weather        for select to anon, authenticated using (true);

drop policy if exists "public read model_coefficients"   on public.model_coefficients;
create policy "public read model_coefficients"   on public.model_coefficients   for select to anon, authenticated using (true);

drop policy if exists "public read predictions"          on public.predictions;
create policy "public read predictions"          on public.predictions          for select to anon, authenticated using (true);

-- The footer surfaces ingestion health ("last updated", failure streak).
drop policy if exists "public read ingestion_runs"       on public.ingestion_runs;
create policy "public read ingestion_runs"       on public.ingestion_runs       for select to anon, authenticated using (true);

-- ---------------------------------------------------------------------------
-- 3. Table-level grants. Supabase's default privileges hand `anon` and
--    `authenticated` full DML on new public tables; RLS is what actually stops
--    them. Revoking the write grants as well is belt and braces — a future
--    permissive policy then still cannot turn into an open write endpoint.
-- ---------------------------------------------------------------------------
grant usage on schema public to anon, authenticated;

revoke insert, update, delete, truncate on all tables in schema public from anon, authenticated;

grant select on table
  public.locations,
  public.stations,
  public.aq_observations,
  public.weather_observations,
  public.daily_aq,
  public.daily_weather,
  public.model_coefficients,
  public.predictions,
  public.ingestion_runs
to anon, authenticated;

-- push_subscriptions: no grants, no policies, no access. v2 will write it
-- through a server route using the service role.
revoke all on table public.push_subscriptions from anon, authenticated;

-- Views inherit the caller's RLS because of `security_invoker = true`
-- (0002_views.sql), so a plain SELECT grant is safe.
grant select on table public.prediction_scores, public.model_accuracy to anon, authenticated;
