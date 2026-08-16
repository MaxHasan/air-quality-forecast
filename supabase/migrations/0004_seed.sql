-- ============================================================================
-- 0004_seed.sql — reference data.
--
-- Idempotent: every statement upserts, so re-running the migration (or running
-- it against a project that already has data) is safe and non-destructive.
-- Kept in sync by hand with src/lib/stations.ts — the two must agree.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- locations
--
-- Timezones are load-bearing: every daily rollup, prediction target date and
-- chart axis is bucketed with them.
--   Jakarta / BSD  -> Asia/Jakarta   (WIB,  UTC+7)
--   Denpasar, Bali -> Asia/Makassar  (WITA, UTC+8)  <- NOT Asia/Jakarta
--   Singapore      -> Asia/Singapore (SGT,  UTC+8)
-- None of the three observe DST.
--
-- Singapore coordinates are the region centroids published in the data.gov.sg
-- PSI/PM2.5 `region_metadata` block, so the weather pull lines up with the
-- regional PM2.5 feed.
-- ---------------------------------------------------------------------------
insert into public.locations (slug, name, country, timezone, lat, lon) values
  ('jakarta-central', 'Jakarta (Central)', 'ID', 'Asia/Jakarta',   -6.186200, 106.834000),
  ('bsd',             'BSD City',          'ID', 'Asia/Jakarta',   -6.301900, 106.652800),
  ('bali-denpasar',   'Denpasar, Bali',    'ID', 'Asia/Makassar',  -8.650000, 115.216700),
  ('sg-central',      'Singapore Central', 'SG', 'Asia/Singapore',  1.357350, 103.820000),
  ('sg-north',        'Singapore North',   'SG', 'Asia/Singapore',  1.418030, 103.820000),
  ('sg-south',        'Singapore South',   'SG', 'Asia/Singapore',  1.295870, 103.820000),
  ('sg-east',         'Singapore East',    'SG', 'Asia/Singapore',  1.357350, 103.940000),
  ('sg-west',         'Singapore West',    'SG', 'Asia/Singapore',  1.357350, 103.700000)
on conflict (slug) do update set
  name     = excluded.name,
  country  = excluded.country,
  timezone = excluded.timezone,
  lat      = excluded.lat,
  lon      = excluded.lon;

-- ---------------------------------------------------------------------------
-- stations — VERIFIED WAQI feeds only.
--
-- These three uids were confirmed live during planning (2026-08-16). WAQI's
-- `source_station_id` is the numeric uid *without* the '@' prefix; the feed URL
-- is  https://api.waqi.info/feed/@<uid>/?token=$WAQI_TOKEN .
-- ---------------------------------------------------------------------------
insert into public.stations (location_id, source, source_station_id, name, network, is_active)
select l.id, v.source, v.source_station_id, v.name, v.network, true
from (values
  -- location slug,      source,  uid,        display name,                     network
  ('jakarta-central', 'waqi', '556480', 'Menteng 2, Central Jakarta',        'nafas'),
  ('bsd',             'waqi', '537739', 'Pondok Aren, South Tangerang',      'nafas'),
  -- Padangsambian Kaja is verified as a live WAQI feed; the upstream network
  -- is left null until discover-stations.ts reads the feed attribution.
  ('bali-denpasar',   'waqi', '503785', 'Padangsambian Kaja, Denpasar',      null)
) as v (location_slug, source, source_station_id, name, network)
join public.locations l on l.slug = v.location_slug
on conflict (source, source_station_id) do update set
  location_id = excluded.location_id,
  name        = excluded.name,
  network     = excluded.network;

-- ---------------------------------------------------------------------------
-- stations — data.gov.sg regional feeds.
--
-- Singapore reports PM2.5 per region rather than per physical station, so the
-- "station" here is the region itself and source_station_id is the region name
-- exactly as it appears in the v2 API response.
-- Endpoint: https://api-open.data.gov.sg/v2/real-time/api/pm25?date=YYYY-MM-DD
-- ---------------------------------------------------------------------------
insert into public.stations (location_id, source, source_station_id, name, network, lat, lon, is_active)
select l.id, 'datagovsg', v.region, v.name, 'nea', l.lat, l.lon, true
from (values
  ('sg-central', 'central', 'NEA Central region'),
  ('sg-north',   'north',   'NEA North region'),
  ('sg-south',   'south',   'NEA South region'),
  ('sg-east',    'east',    'NEA East region'),
  ('sg-west',    'west',    'NEA West region')
) as v (location_slug, region, name)
join public.locations l on l.slug = v.location_slug
on conflict (source, source_station_id) do update set
  location_id = excluded.location_id,
  name        = excluded.name,
  network     = excluded.network,
  lat         = excluded.lat,
  lon         = excluded.lon;

-- ===========================================================================
-- TODO (M2A) — STATIONS AWAITING ID RESOLUTION
-- ===========================================================================
-- The three feeds below are named in the plan but their WAQI uids were never
-- verified. `npm run discover:stations` (scripts/discover-stations.ts) resolves
-- them via GET /search/?keyword= and GET /v2/map/bounds/?latlng=, checks that
-- `data.time.iso` is fresher than 6 hours, and prints a ready-to-paste INSERT.
--
--   * BMKG Kemayoran      -> jakarta-central  (network 'bmkg')
--       Second, independent feed for Central Jakarta. Also the station behind
--       the 2022-2023 calibration weather file, so it is the natural
--       cross-check for the fitted coefficients.
--   * Denpasar Lumintang  -> bali-denpasar    (network likely 'nafas')
--   * Umalas              -> bali-denpasar    (network likely 'nafas')
--       Bali currently has a single feed; either of these removes the single
--       point of failure against WAQI station dormancy.
--
-- Paste the resolved rows here, uncomment, and re-run this migration (the
-- upserts above make that safe):
--
-- insert into public.stations (location_id, source, source_station_id, name, network, is_active)
-- select l.id, v.source, v.source_station_id, v.name, v.network, true
-- from (values
--   ('jakarta-central', 'waqi', '<UID>', 'BMKG Kemayoran, Central Jakarta', 'bmkg'),
--   ('bali-denpasar',   'waqi', '<UID>', 'Lumintang, Denpasar',            'nafas'),
--   ('bali-denpasar',   'waqi', '<UID>', 'Umalas, Badung',                 'nafas')
-- ) as v (location_slug, source, source_station_id, name, network)
-- join public.locations l on l.slug = v.location_slug
-- on conflict (source, source_station_id) do update set
--   location_id = excluded.location_id,
--   name        = excluded.name,
--   network     = excluded.network;
-- ===========================================================================
