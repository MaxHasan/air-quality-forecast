-- ============================================================================
-- 0007_jakarta_regions.sql — decompose Jakarta into administrative cities.
--
-- Why: `jakarta-central` was carrying the whole of a 660 km² metropolis on one
-- card. Singapore has been served as five NEA regions since 0004 precisely
-- because a city's air is not one number, and Jakarta — larger, dirtier, and
-- the reason this app exists — had less spatial resolution than the secondary
-- market. This migration gives DKI Jakarta the same treatment.
--
-- WHAT THIS IS NOT: a rename. `jakarta-central` keeps its slug, its anchor
-- coordinates and all four of its stations. Its `daily_aq` history, its fitted
-- `model_coefficients` and its `prediction_scores` all stay valid, and no
-- station-mix discontinuity is introduced for it — unlike 0006, which had to
-- record one. The new locations start empty and accumulate from today.
--
-- ---------------------------------------------------------------------------
-- The station survey this is built on (live, 2026-08-19)
-- ---------------------------------------------------------------------------
-- WAQI `/v2/map/bounds/` over Jabodetabek returns 14 stations; the AirGradient
-- public world map returns 8 in the same box. Sorted into DKI's five cities:
--
--   Jakarta Pusat    waqi 8294 Kemayoran (BMKG), waqi -416842 GBK (KLHK),
--                    ag 84702 Menteng, ag 199980 BMKG 1     -> 4, all existing
--   Jakarta Utara    waqi -531679 KBN Marunda (KLHK)        -> 1, NEW
--   Jakarta Barat    ag 84701 Kedoya Utara (Nafas)          -> 1, NEW
--   Jakarta Selatan  ag 175134 Permata Hijau (Nafas),
--                    ag 77248 Pakubuwono 3 (Nafas)          -> 2, NEW
--   Jakarta Timur    (nothing, in either network)
--
-- Three of these four new stations are ones earlier migrations explicitly
-- parked. 0004's KNOWN GAPS listed `-531679 KBN Marunda, North Jakarta` and
-- `-416815 Bekasi Kayuringin` as "valid and fresh; add a location row first".
-- 0006 recorded Kedoya Utara and Permata Hijau as "live but seeded nowhere,
-- because no location covers them. Add a location row first if those areas ever
-- matter." This is that location row. Nothing here is a new discovery; it is
-- the collection of debts those two migrations wrote down.
--
-- ---------------------------------------------------------------------------
-- Why there is no `jakarta-east`
-- ---------------------------------------------------------------------------
-- Jakarta Timur has no public PM2.5 feed. A tight WAQI sweep of the box
-- (-6.40,106.85,-6.10,107.00) returns exactly two stations and neither is in
-- it: KBN Marunda (Utara) and Bekasi Kayuringin (Kota Bekasi). AirGradient has
-- nothing east of Menteng.
--
-- A `jakarta-east` seeded anyway would be a location that can never hold a
-- reading: `daily_aq` permanently empty, so no persistence model, no
-- `pm25_lag` for the wind regression, nothing for `prediction_scores` to score
-- against, and a card showing an unfalsifiable CAMS number off a 40 km grid
-- that cannot resolve intra-metro variation in the first place. That is the
-- kind of confident-looking emptiness the rest of this schema goes out of its
-- way to refuse.
--
-- So instead: `bekasi` is seeded as its own city. It is the eastern satellite,
-- the counterpart to BSD in the west, and it is named after the place its
-- sensor is actually in rather than being dressed up as East Jakarta — which
-- it is not (different administrative city, ~11 km further east, and an
-- industrial rather than residential airshed). It is a comparison point, and
-- it is labelled as one.
--
-- Re-run `npm run discover:stations` periodically. The day Jakarta Timur gets a
-- feed, adding the location is a three-line follow-up: `nafas_east_jakarta.csv`
-- is already in the calibration archive waiting for it.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- locations
--
-- Coordinates are the weather-pull anchor for each region — the point ERA5 is
-- read at during calibration and Open-Meteo at inference. They are the
-- administrative centroid of each city, matching the grain of the Nafas
-- per-city PM2.5 the coefficients are fitted against, and matching the way
-- Singapore's rows use NEA's published region centroids.
--
-- `jakarta-central` is listed here only so the upsert leaves it explicitly
-- unchanged apart from its display name. ITS LAT/LON MUST NOT MOVE: the active
-- v1 coefficients were fitted on ERA5 read at exactly this point, and shifting
-- it would leave a slope fitted against one column of weather being applied to
-- another, with no error anywhere to show for it.
-- ---------------------------------------------------------------------------
insert into public.locations (slug, name, country, timezone, lat, lon) values
  ('jakarta-central', 'Jakarta Central', 'ID', 'Asia/Jakarta', -6.186200, 106.834000),
  ('jakarta-north',   'Jakarta North',   'ID', 'Asia/Jakarta', -6.121400, 106.882700),
  ('jakarta-south',   'Jakarta South',   'ID', 'Asia/Jakarta', -6.261500, 106.810600),
  ('jakarta-west',    'Jakarta West',    'ID', 'Asia/Jakarta', -6.168300, 106.758800),
  ('bekasi',          'Bekasi',          'ID', 'Asia/Jakarta', -6.238300, 106.975600)
on conflict (slug) do update set
  name     = excluded.name,
  country  = excluded.country,
  timezone = excluded.timezone,
  lat      = excluded.lat,
  lon      = excluded.lon;

-- ---------------------------------------------------------------------------
-- stations — WAQI.
--
-- Both verified live on 2026-08-19 by fetching `/feed/@uid/` directly, not just
-- by appearing in the bounds sweep: a uid the sweep returns whose feed answers
-- an error status is a ghost, and seeding it produces a station that never
-- reports. Both returned a fresh `iaqi.pm25` and KLHK attribution.
--
-- Each of these locations has exactly ONE feed, which makes both of them what
-- Bali was before 0006: a single point of failure. `ingest/aq.ts` will mark the
-- station dormant after DORMANT_STATION_DAYS and the location falls back to
-- CAMS alone. Nothing better exists to pair them with today.
-- ---------------------------------------------------------------------------
insert into public.stations (location_id, source, source_station_id, name, network, lat, lon, is_active)
select l.id, 'waqi', v.source_station_id, v.name, v.network, v.lat, v.lon, true
from (values
  -- KBN Marunda is 6.9 km ENE of Jakarta Utara's centroid, at the far eastern
  -- end of the coastal strip; Kayuringin is 1.9 km E of Bekasi's.
  ('jakarta-north', '-531679', 'KBN Marunda, North Jakarta', 'klhk', -6.108980, 106.944000),
  ('bekasi',        '-416815', 'Bekasi Kayuringin',          'klhk', -6.237500, 106.993000)
) as v (location_slug, source_station_id, name, network, lat, lon)
join public.locations l on l.slug = v.location_slug
on conflict (source, source_station_id) do update set
  location_id = excluded.location_id,
  name        = excluded.name,
  network     = excluded.network,
  lat         = excluded.lat,
  lon         = excluded.lon;

-- ---------------------------------------------------------------------------
-- stations — AirGradient.
--
-- Every lat/lon is copied verbatim from the world payload's own
-- `latitude`/`longitude`, per 0006's warning: an earlier draft of that
-- migration carried hand-typed Bali coordinates that were 0.9–2.3 km wrong.
--
-- Distance from each location's anchor:
--   jakarta-west   84701  Kedoya Utara       0.5 km SE   (Nafas)
--   jakarta-south  175134 Permata Hijau      5.0 km NNW  (Nafas)
--                  77248  Pakubuwono 3       3.8 km NW   (Nafas)
--
-- These are the tightest station-to-anchor fits in the Indonesian half of the
-- map — a direct consequence of the anchors having been placed after the
-- stations were known, rather than the other way round.
--
-- Readings arrive RAW and are EPA-humidity-corrected by the connector before
-- storage; see scripts/lib/airgradient.ts. That correction is why these three
-- are commensurable with the reference-grade WAQI feeds at all.
-- ---------------------------------------------------------------------------
insert into public.stations (location_id, source, source_station_id, name, network, lat, lon, is_active)
select l.id, 'airgradient', v.source_station_id, v.name, v.network, v.lat, v.lon, true
from (values
  ('jakarta-west',  '84701',  'Kedoya Utara, Kebon Jeruk',     'nafas', -6.171475, 106.762252),
  ('jakarta-south', '175134', 'Permata Hijau, Kebayoran Lama', 'nafas', -6.222410, 106.788319),
  ('jakarta-south', '77248',  'Pakubuwono 3, Kebayoran Baru',  'nafas', -6.237340, 106.786170)
) as v (location_slug, source_station_id, name, network, lat, lon)
join public.locations l on l.slug = v.location_slug
on conflict (source, source_station_id) do update set
  location_id = excluded.location_id,
  name        = excluded.name,
  network     = excluded.network,
  lat         = excluded.lat,
  lon         = excluded.lon;

-- ===========================================================================
-- KNOWN GAPS after this migration
-- ===========================================================================
-- * NO JAKARTA TIMUR. Nothing public exists to seed. Re-run
--   `npm run discover:stations`; `nafas_east_jakarta.csv` is already staged for
--   the fit if a feed ever appears.
--
-- * jakarta-north, jakarta-west and bekasi each run on ONE station. Any of the
--   three going dormant drops that location to CAMS alone. jakarta-south has
--   two, but both are Nafas AirGradient units ~2 km apart, so they share a
--   network, a sensor class and a correction formula — redundancy against
--   downtime, not against systematic bias.
--
-- * The four new locations have NO reference-grade monitor. jakarta-central is
--   the only Jakarta region with a BAM (Kemayoran, waqi 8294) and therefore the
--   only one where `npm run verify:colocation` means anything. Treat the
--   AirGradient-only regions' absolute levels as corrected-optical, and prefer
--   comparing them to each other over comparing them to Central.
--
-- * Still found-but-unseeded in the 2026-08-19 sweep, should a location ever
--   want them:
--     -471616  Jakarta (Clarity)          -6.0966, 106.9613  (NE Jakarta)
--     -515938  Tangerang Benteng Betawi   -6.1757, 106.6450
--     -515941  Tangerang Karang Tengah    -6.2098, 106.7050
--     -515944  Tangerang Kali Pasir       -6.1874, 106.6330
--     -416803  Tangerang Pasir Jaya       -6.1975, 106.5700
--     -416827  Kabupaten Bekasi Sukamahi  -6.3638, 107.1720
--     -416914  Kab. Bogor Tegar Beriman   -6.4814, 106.8290
--     -472486  Kab. Bogor Leuwiliang      -6.5766, 106.6370
--     -417100  Kab. Tangerang Tigaraksa   -6.2699, 106.4840
--
-- * ATTRIBUTION DISCREPANCY, not fixed here. The live world payload reports
--   `publicContributorName: "Nafas"` for ag 84702 (Menteng) and ag 199980
--   (BMKG 1), which 0006 seeded with `network = null`. Either the field changed
--   upstream or 0006 read it wrong. Left alone deliberately: correcting another
--   migration's rows is a separate change from adding locations.
-- ===========================================================================
