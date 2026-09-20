-- ===========================================================================
-- 0012 — retire jakarta-north: deactivate its dead station. Delete nothing.
--
-- APPLY ANY TIME, before or after the code merge. The station being
-- deactivated has not reported since 2026-08-26, so deactivating it removes no
-- data that was arriving. Applied before the merge, the app keeps showing a
-- stale Jakarta North card, exactly as it does today. Applied after, the card
-- is already gone because `LOCATIONS` no longer lists the slug.
--
-- ---------------------------------------------------------------------------
-- Why the location row stays
-- ---------------------------------------------------------------------------
-- `locations.id` is referenced by `stations`, `aq_observations` (through
-- stations), `weather_observations`, `daily_aq`, `daily_weather`,
-- `model_coefficients` and `predictions` — every one of them
-- `on delete cascade`. Deleting the location would silently take months of
-- real measurements, the predictions made against them, and the scores those
-- produced. None of that became untrue when the sensor stopped.
--
-- So retirement is a display and scheduling decision, taken in
-- src/lib/stations.ts (`RETIRED_LOCATIONS`), and the database simply keeps the
-- history. `fetchLocations` skips the slug without logging drift;
-- `loadLocations` stops handing it to the ingestion jobs.
--
-- ---------------------------------------------------------------------------
-- What was checked before deciding
-- ---------------------------------------------------------------------------
-- Swept both networks on 2026-09-20:
--
--   * WAQI `/v2/map/bounds/` over Jabodetabek — jakarta-north returned
--     "0 fresh  ✗ NO LIVE COVERAGE" within 25 km.
--   * AirGradient's public world map, 2815 stations — nothing in Jakarta Utara
--     at all. Everything within 30 km of the centroid is already seeded to
--     another location, and the single unseeded candidate (207378, Griya Tugu
--     Asri) is 27 km away to the SOUTH, which is a different city's air.
--
-- The station's own registry comment called this in advance: "Jakarta Utara's
-- only feed, in either network ... If it goes quiet, Jakarta North has
-- nothing." It went quiet. It had nothing.
--
-- Its last six scored days (2026-08-21..26) were healthy — 20-23 hours each,
-- actuals 11.0-16.0 µg/m³ — so the history being kept is good history, not
-- noise. It is the absence that followed that ends the location.
--
-- ---------------------------------------------------------------------------
-- Reversing this
-- ---------------------------------------------------------------------------
-- If a North Jakarta feed appears, nothing here blocks it: seed the new
-- station against this same location row, drop the entry from
-- `RETIRED_LOCATIONS`, and restore the `LOCATIONS` entry. The history is still
-- attached, so the location comes back with its past intact rather than as a
-- cold start.
-- ===========================================================================

begin;

update public.stations
set is_active = false
where source = 'waqi'
  and source_station_id = '-531679';

commit;

-- ---------------------------------------------------------------------------
-- Verification — the station is present and inactive, the location row is
-- still there, and its observations are still attached.
-- ---------------------------------------------------------------------------
-- select l.slug, s.source, s.source_station_id, s.is_active, s.last_seen_at,
--        (select count(*) from public.aq_observations o where o.station_id = s.id) as observations
-- from public.stations s
-- join public.locations l on l.id = s.location_id
-- where l.slug = 'jakarta-north';
