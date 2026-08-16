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
-- stations — WAQI feeds, resolved against the live API on 2026-08-16.
--
-- `source_station_id` is WAQI's uid *without* the '@' prefix; the feed URL is
--   https://api.waqi.info/feed/@<uid>/?token=$WAQI_TOKEN
-- Note some uids are NEGATIVE — that is normal for WAQI and the column is text,
-- so '-416785' is stored verbatim and the '@' is added by the connector.
--
-- Resolved by sweeping GET /v2/map/bounds/ over Jabodetabek and Bali, then
-- confirming each feed returns a fresh iaqi.pm25.v. Two findings changed the
-- plan:
--
--   * There are NO Nafas feeds on WAQI. The uids originally planned for Menteng
--     (556480), Pondok Aren (537739) and Padangsambian Kaja (503785) every one
--     return {"status":"error","msg":"Unknown ID"}, and a bounds sweep of
--     Jabodetabek returns 13 stations with not one attributed to Nafas.
--     Indonesian ground truth is BMKG + KLHK (+ one Clarity sensor).
--   * Bali has exactly ONE station in range, ~6 km NW of central Denpasar.
--     No redundancy: if it goes quiet, Bali falls back to CAMS alone.
--
-- Usefully, 8294 (Kemayoran) is the same BMKG station behind the 2022-2023
-- calibration weather, so Jakarta's ground truth and its training weather share
-- a source. It is also the only Indonesian feed carrying WAQI's forecast block.
-- ---------------------------------------------------------------------------
insert into public.stations (location_id, source, source_station_id, name, network, is_active)
select l.id, v.source, v.source_station_id, v.name, v.network, true
from (values
  -- location slug,      source,  uid,         display name,                  network
  ('jakarta-central', 'waqi', '8294',     'Kemayoran, Central Jakarta',   'bmkg'),
  -- Second Jakarta feed, so the location survives one station going quiet.
  ('jakarta-central', 'waqi', '-416842',  'Jakarta GBK',                  'klhk'),
  ('bsd',             'waqi', '-416785',  'Tangerang Selatan, Serpong',   'klhk'),
  ('bali-denpasar',   'waqi', '-519205',  'Badung Sempidi, Bali',         'klhk')
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
-- KNOWN GAPS
-- ===========================================================================
-- * Bali has a single station (Badung Sempidi). Re-run
--   `npm run discover:stations` periodically: WAQI's Indonesian coverage does
--   change, and a second Bali feed would remove a real single point of failure.
--
-- * Other Jabodetabek stations found live on 2026-08-16 but not seeded. They are
--   valid and fresh; add a location row first if any of these becomes wanted:
--     -471616  Jakarta (Clarity)          -6.0966, 106.9613  (NE Jakarta)
--     -515941  Tangerang Karang Tengah    -6.2098, 106.7050
--     -515944  Tangerang Kali Pasir
--     -416815  Bekasi Kayuringin
--     -416827  Kabupaten Bekasi Sukamahi
--     -531679  KBN Marunda, North Jakarta
--     -416914  Kabupaten Bogor Tegar Beriman
--     -472486  Kabupaten Bogor Leuwiliang
--     -417100  Kabupaten Tangerang Tigaraksa
--
-- * Singapore deliberately uses data.gov.sg rather than WAQI's NEA mirror
--   (uids 1662-1666): same underlying readings, but native µg/m³ instead of an
--   AQI sub-index, and a licence that permits storage and redisplay outright.
--   Those WAQI uids are still how the EPA breakpoint table was verified —
--   see the note in src/lib/aqi.ts.
-- ===========================================================================
