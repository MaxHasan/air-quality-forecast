-- ============================================================================
-- 0001_init.sql — THE CONTRACT
--
-- Air Quality Predictor: core schema. Every other artefact in the repo
-- (src/lib/types.ts, the ingestion scripts, the PWA queries) mirrors this file.
-- Changes after milestone M1 require a new migration + a matching types.ts
-- update in the same PR.
--
-- Conventions
--   * All timestamps are `timestamptz` and stored in UTC.
--   * "local_date" columns are the calendar date in the *location's* IANA
--     timezone (WIB / WITA / SGT). Bali is Asia/Makassar, not Asia/Jakarta.
--     Bucketing is done in TypeScript (src/lib/format.ts), never in SQL, so
--     that rollups and the UI agree byte-for-byte.
--   * PM2.5 concentrations are µg/m³ (`*_ugm3` / `*_pm25`), AQI values are the
--     unitless US-EPA index. WAQI returns AQI sub-indices, not concentrations —
--     see src/lib/aqi.ts.
--   * Wind speed is m/s everywhere (Open-Meteo is requested with
--     wind_speed_unit=ms). Temperature is °C.
--   * Everything is written by the service role; the browser only ever SELECTs
--     (see 0003_rls.sql).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- locations — the user-facing places. Also the grain of weather, rollups,
-- coefficients and predictions.
-- ---------------------------------------------------------------------------
create table if not exists public.locations (
  id          bigint generated always as identity primary key,
  slug        text        not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name        text        not null,
  country     text        not null check (country in ('ID', 'SG')),  -- ISO 3166-1 alpha-2
  timezone    text        not null,                                  -- IANA zone, e.g. 'Asia/Makassar'
  lat         double precision not null check (lat between -90 and 90),
  lon         double precision not null check (lon between -180 and 180),
  created_at  timestamptz not null default now()
);

comment on table  public.locations             is 'User-facing places. Grain of weather, rollups, coefficients and predictions.';
comment on column public.locations.timezone    is 'IANA timezone used for every local_date bucket. Bali = Asia/Makassar (WITA).';

-- ---------------------------------------------------------------------------
-- stations — physical/logical PM2.5 feeds mapped onto a location. A location
-- may have several (redundancy against WAQI station dormancy).
-- ---------------------------------------------------------------------------
create table if not exists public.stations (
  id                bigint generated always as identity primary key,
  location_id       bigint      not null references public.locations (id) on delete cascade,
  source            text        not null check (source in ('waqi', 'datagovsg')),
  source_station_id text        not null,   -- WAQI numeric uid *without* the '@' prefix, or a data.gov.sg region name
  name              text        not null,
  network           text        check (network in ('nafas', 'bmkg', 'klhk', 'nea')),  -- null = upstream network unconfirmed
  lat               double precision check (lat between -90 and 90),
  lon               double precision check (lon between -180 and 180),
  is_active         boolean     not null default true,
  last_seen_at      timestamptz,            -- newest observation timestamp seen; drives the 14-day auto-deactivate
  created_at        timestamptz not null default now(),
  unique (source, source_station_id)
);

create index if not exists stations_active_by_location_idx
  on public.stations (location_id)
  where is_active;

comment on column public.stations.source_station_id is 'WAQI: numeric uid without ''@'' (e.g. ''556480''). data.gov.sg: region name (north|south|east|west|central).';
comment on column public.stations.last_seen_at      is 'Freshness bookkeeping: feeds older than 6h are skipped, older than 14d are deactivated.';

-- ---------------------------------------------------------------------------
-- aq_observations — hourly ground truth, one row per station × instant.
-- WAQI `iaqi.pm25.v` is a US-EPA AQI sub-index, NOT µg/m³: store the raw index
-- and the inverted concentration side by side so a wrong breakpoint table can
-- be corrected later without re-fetching.
-- ---------------------------------------------------------------------------
create table if not exists public.aq_observations (
  station_id   bigint      not null references public.stations (id) on delete cascade,
  observed_at  timestamptz not null,
  pm25_ugm3    double precision check (pm25_ugm3 >= 0),                 -- concentration (inverted from AQI for WAQI, native for data.gov.sg)
  pm25_aqi_us  integer          check (pm25_aqi_us between 0 and 1000), -- raw US-EPA sub-index as published (null for native-concentration sources)
  aqi_table    text             check (aqi_table in ('epa-pre-2024', 'epa-2024')),  -- which breakpoint table produced pm25_ugm3
  raw          jsonb,                                                   -- upstream payload; nulled after 30 days by retention.ts
  ingested_at  timestamptz not null default now(),
  primary key (station_id, observed_at),
  constraint aq_observations_has_a_value check (pm25_ugm3 is not null or pm25_aqi_us is not null)
);

create index if not exists aq_observations_observed_at_idx
  on public.aq_observations (observed_at desc);

comment on column public.aq_observations.aqi_table is 'Breakpoint table used for the AQI->µg/m³ inversion. Lets a later correction target only affected rows.';

-- ---------------------------------------------------------------------------
-- weather_observations — hourly weather per location. `source` is part of the
-- key so a second provider can be added (BMKG, M6) without displacing
-- Open-Meteo history.
-- ---------------------------------------------------------------------------
create table if not exists public.weather_observations (
  location_id   bigint      not null references public.locations (id) on delete cascade,
  observed_at   timestamptz not null,
  source        text        not null check (source in ('openmeteo', 'datagovsg', 'bmkg')),
  temp_c        double precision,
  wind_speed_ms double precision check (wind_speed_ms >= 0),
  wind_dir_deg  double precision check (wind_dir_deg >= 0 and wind_dir_deg < 360),  -- meteorological: direction wind blows FROM
  wind_gusts_ms double precision check (wind_gusts_ms >= 0),
  rh_pct        double precision check (rh_pct between 0 and 100),
  precip_mm     double precision check (precip_mm >= 0),
  blh_m         double precision check (blh_m >= 0),                                -- boundary-layer height
  ingested_at   timestamptz not null default now(),
  primary key (location_id, observed_at, source)
);

create index if not exists weather_observations_observed_at_idx
  on public.weather_observations (observed_at desc);

-- ---------------------------------------------------------------------------
-- daily_aq — rollup TABLE (not a view) written by scripts/rollup.ts, keyed on
-- the location's LOCAL date. Kept forever: this is the model's training data.
-- ---------------------------------------------------------------------------
create table if not exists public.daily_aq (
  location_id   bigint  not null references public.locations (id) on delete cascade,
  local_date    date    not null,
  pm25_avg      double precision not null check (pm25_avg >= 0),
  pm25_min      double precision check (pm25_min >= 0),
  pm25_max      double precision check (pm25_max >= 0),
  hours_count   smallint not null check (hours_count between 1 and 24),  -- distinct local hours with data; coverage guard
  station_count smallint not null default 1 check (station_count >= 1),
  computed_at   timestamptz not null default now(),
  primary key (location_id, local_date)
);

comment on column public.daily_aq.hours_count is 'Distinct hours contributing to the mean. Scoring (0002_views.sql) ignores days below 12.';

-- ---------------------------------------------------------------------------
-- daily_weather — rollup TABLE written by scripts/rollup.ts. Wind direction is
-- VECTOR-averaged: the scalar mean of 350° and 10° is 180°, which would erase
-- the seasonal easterly-vs-north-westerly signal the analysis relies on.
-- ---------------------------------------------------------------------------
create table if not exists public.daily_weather (
  location_id          bigint  not null references public.locations (id) on delete cascade,
  local_date           date    not null,
  source               text    not null check (source in ('openmeteo', 'datagovsg', 'bmkg')),
  temp_avg_c           double precision,
  temp_min_c           double precision,
  temp_max_c           double precision,
  wind_speed_avg_ms    double precision check (wind_speed_avg_ms >= 0),   -- THE predictor
  wind_speed_max_ms    double precision check (wind_speed_max_ms >= 0),
  wind_dir_vector_deg  double precision check (wind_dir_vector_deg >= 0 and wind_dir_vector_deg < 360),
  wind_dir_consistency double precision check (wind_dir_consistency between 0 and 1),  -- resultant length: 1 = steady, 0 = fully variable
  rh_avg_pct           double precision check (rh_avg_pct between 0 and 100),
  precip_mm_total      double precision check (precip_mm_total >= 0),
  blh_avg_m            double precision check (blh_avg_m >= 0),
  hours_count          smallint not null check (hours_count between 1 and 24),
  computed_at          timestamptz not null default now(),
  primary key (location_id, local_date, source)
);

comment on column public.daily_weather.wind_dir_vector_deg  is 'Vector (circular) mean of hourly wind direction — preserves the seasonal signal a scalar mean destroys.';
comment on column public.daily_weather.wind_dir_consistency is 'Length of the mean unit vector (0..1). Low values mean the daily direction is meaningless.';

-- ---------------------------------------------------------------------------
-- model_coefficients — versioned OLS fits. Old versions are never deleted;
-- at most one row per (location, model) may be active.
-- ---------------------------------------------------------------------------
create table if not exists public.model_coefficients (
  id          bigint      generated always as identity primary key,
  location_id bigint      not null references public.locations (id) on delete cascade,
  model       text        not null check (model in ('wind_regression')),
  version     integer     not null check (version > 0),
  intercept   double precision not null,
  coef        jsonb       not null,  -- {"wind_speed_avg_ms": -4.2, "temp_avg_c": -0.339}
  stats       jsonb       not null default '{}'::jsonb,  -- {r2, n, rmse, period_start, period_end, source}
  is_active   boolean     not null default false,
  fitted_at   timestamptz not null default now(),
  unique (location_id, model, version)
);

create unique index if not exists model_coefficients_single_active_idx
  on public.model_coefficients (location_id, model)
  where is_active;

comment on column public.model_coefficients.coef is 'Predictor name -> slope. Names match daily_weather columns so predict.ts can look them up generically.';

-- ---------------------------------------------------------------------------
-- predictions — one row per location × target local date × model × horizon.
-- Re-runs overwrite via the unique key (idempotent).
-- ---------------------------------------------------------------------------
create table if not exists public.predictions (
  id              bigint   generated always as identity primary key,
  location_id     bigint   not null references public.locations (id) on delete cascade,
  target_date     date     not null,                                       -- LOCAL date being predicted
  horizon_days    smallint not null check (horizon_days between 1 and 3),
  model           text     not null check (model in ('wind_regression', 'cams', 'persistence')),
  predicted_pm25  double precision not null check (predicted_pm25 >= 0),   -- predict.ts clamps the regression at 0
  coefficients_id bigint   references public.model_coefficients (id) on delete set null,  -- wind_regression only
  inputs          jsonb    not null default '{}'::jsonb,  -- {wind_speed_avg_ms, temp_avg_c, observed_hours, forecast_run, ...}
  run_at          timestamptz not null default now(),
  unique (location_id, target_date, model, horizon_days)
);

create index if not exists predictions_target_date_idx
  on public.predictions (target_date desc);

-- ---------------------------------------------------------------------------
-- ingestion_runs — job log. The PWA footer reads the latest rows to surface a
-- failure streak; the retention job reads it to know what has been pruned.
-- ---------------------------------------------------------------------------
create table if not exists public.ingestion_runs (
  id            bigint      generated always as identity primary key,
  job           text        not null check (job in ('ingest-aq', 'ingest-weather', 'rollup', 'predict', 'backfill', 'retention', 'calibrate', 'keepalive')),
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  status        text        not null default 'running' check (status in ('running', 'ok', 'partial', 'error')),
  rows_upserted integer     not null default 0 check (rows_upserted >= 0),
  error         text,
  meta          jsonb       not null default '{}'::jsonb  -- {stations_ok, stations_failed, window_start, window_end, ...}
);

create index if not exists ingestion_runs_job_started_idx
  on public.ingestion_runs (job, started_at desc);

comment on column public.ingestion_runs.status is 'partial = some stations failed but the run produced data. Per-station failures are never fatal.';

-- ---------------------------------------------------------------------------
-- push_subscriptions — created now, unused until v2. No anon policy is ever
-- granted on this table (see 0003_rls.sql).
-- ---------------------------------------------------------------------------
create table if not exists public.push_subscriptions (
  id               bigint      generated always as identity primary key,
  endpoint         text        not null unique,
  p256dh           text        not null,
  auth             text        not null,
  location_id      bigint      references public.locations (id) on delete cascade,
  activity         text        check (activity in ('newborn_walk', 'running', 'swimming')),
  threshold_pm25   double precision check (threshold_pm25 >= 0),
  user_agent       text,
  created_at       timestamptz not null default now(),
  last_notified_at timestamptz
);

comment on table public.push_subscriptions is 'v2 web-push. Schema only — nothing reads or writes it in v1.';
