-- ============================================================================
-- 0006_airgradient.sql — admit AirGradient as a third PM2.5 source.
--
-- Why: the plan's original bet — Nafas's sensor network via WAQI — turned out
-- to be false (WAQI carries no Nafas feeds; see 0004's header). A live survey
-- on 2026-08-18 found where Nafas actually publishes: the AirGradient public
-- world map (api.airgradient.com), keyless, with Nafas as a named contributor.
-- 8 Jakarta-area stations (6 Nafas-branded), 10 in Bali against WAQI's one —
-- which removes Bali's single point of failure — all in real µg/m³ with
-- temperature and relative humidity in the same payload.
--
-- Licence: data via the AirGradient API is CC-BY-SA 4.0
-- (https://www.airgradient.com/documentation/data-ownership-and-sharing/).
-- Attribution lives on /about next to WAQI's and Open-Meteo's.
--
-- THE MEASUREMENT CAVEAT, because it shapes what gets stored: these are
-- low-cost optical sensors (Plantower-class), and the API serves RAW readings.
-- Raw optical PM2.5 overreads badly in humid tropical air — the AirGradient
-- unit at BMKG headquarters read ~52 µg/m³ while the co-located reference BAM
-- showed ~29. The connector therefore applies the US-EPA (Barkjohn 2021)
-- humidity correction before anything reaches `pm25_ugm3`, and stores the raw
-- value + RH + formula id in `raw` — the inputs a re-derivation would need if
-- the correction is ever revised (no such script exists yet; the inputs are
-- kept so one can be written). That same BMKG co-location pair doubles as a
-- standing calibration check (`npm run verify:colocation`).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Widen the source check.
--
-- 0001 declared the check inline on the column, which means Postgres both
-- auto-named it (`stations_source_check`) and NORMALISED its text: what was
-- written as
--     check (source in ('waqi', 'datagovsg'))
-- is stored as
--     CHECK ((source = ANY (ARRAY['waqi'::text, 'datagovsg'::text])))
--
-- That normalisation broke the first version of this migration. It hunted for
-- the constraint with `pg_get_constraintdef(oid) ilike '%source%in%'` -- a
-- pattern matching the SQL as authored, not as stored. There is no "in" in the
-- ANY/ARRAY form, so it matched nothing, dropped nothing, and the ADD below
-- then collided with the surviving name:
--     ERROR 42710: constraint "stations_source_check" for relation "stations"
--     already exists
--
-- So: match the catalogue structurally instead of by text. `conkey` holds the
-- columns a constraint covers, so joining through pg_attribute finds every
-- CHECK on `source` whatever it is called and however Postgres chose to render
-- it. That is also what makes this migration re-runnable: on a second pass it
-- drops the three-value constraint and adds it straight back.
-- ---------------------------------------------------------------------------
do $$
declare
  con record;
begin
  for con in
    select c.conname
    from pg_constraint c
    join pg_attribute a
      on a.attrelid = c.conrelid
     and a.attnum = any (c.conkey)
    where c.conrelid = 'public.stations'::regclass
      and c.contype = 'c'
      and a.attname = 'source'
  loop
    execute format('alter table public.stations drop constraint %I', con.conname);
  end loop;
end $$;

alter table public.stations
  add constraint stations_source_check
  check (source in ('waqi', 'datagovsg', 'airgradient'));

comment on column public.stations.source_station_id is
  'WAQI: numeric uid without ''@'' (e.g. ''8294''). data.gov.sg: region name. AirGradient: numeric locationId from the public world map.';

-- ---------------------------------------------------------------------------
-- Seed the stations verified live on 2026-08-18. Every lat/lon below is copied
-- verbatim from the world payload's own `latitude`/`longitude` fields, and the
-- distances in this table are computed from them: an earlier draft carried
-- hand-typed coordinates for the three Bali rows that were 0.9-2.3 km wrong,
-- so treat any coordinate here as unverified until it round-trips against the
-- API.
--
-- Mapping rule: a station joins the nearest location it plausibly represents.
-- Distance and bearing from that location's own anchor point:
--
--   jakarta-central:
--     84702   The Pakubuwono Menteng          1.1 km W
--     199980  BMKG 1                          3.5 km NNE  — at BMKG HQ, beside
--                                             the Kemayoran reference BAM
--                                             (waqi 8294): the standing
--                                             co-location cross-check
--   bsd (South Tangerang):
--     156518  British School Jkt, Pondok Aren  6.6 km ENE  (Nafas)
--     156523  Global Jaya School, Parigi       5.7 km ENE  (Nafas)
--     74891   Ciputat                         10.7 km ESE  (Nafas) — the loosest
--                                             fit of the eight; drop it first if
--                                             BSD's rollup ever looks unlike BSD
--   bali-denpasar:
--     77247   Tonja, Denpasar                  2.3 km NE   (Nafas)
--     203332  Sibang Eco Village               8.4 km N
--     203333  Canggu, Padang Linjong           8.5 km W    — kept because Canggu
--                                             is somewhere the household goes
--
-- Live but seeded nowhere, because no location covers them: Kedoya Utara (West
-- Jakarta) and Permata Hijau (South Jakarta). Add a location row first if those
-- areas ever matter.
-- ---------------------------------------------------------------------------
insert into public.stations (location_id, source, source_station_id, name, network, lat, lon, is_active)
select l.id, 'airgradient', v.source_station_id, v.name, v.network, v.lat, v.lon, true
from (values
  ('jakarta-central', '84702',  'The Pakubuwono Menteng',                null,    -6.1861164, 106.8236334),
  ('jakarta-central', '199980', 'BMKG 1 (co-located with Kemayoran BAM)', null,   -6.1557694, 106.8423941),
  ('bsd',             '156518', 'British School Jakarta, Pondok Aren',   'nafas', -6.272408,  106.704339),
  ('bsd',             '156523', 'Global Jaya School, Parigi',            'nafas', -6.281047,  106.70024),
  ('bsd',             '74891',  'Ciputat',                               'nafas', -6.333194,  106.744433),
  ('bali-denpasar',   '77247',  'Tonja, Denpasar',                       'nafas', -8.632781,  115.229004),
  ('bali-denpasar',   '203332', 'Sibang Eco Village',                    null,    -8.574738,  115.214613),
  ('bali-denpasar',   '203333', 'Canggu, Padang Linjong',                null,    -8.6397188, 115.1398023)
) as v (location_slug, source_station_id, name, network, lat, lon)
join public.locations l on l.slug = v.location_slug
on conflict (source, source_station_id) do update set
  location_id = excluded.location_id,
  name        = excluded.name,
  network     = excluded.network,
  lat         = excluded.lat,
  lon         = excluded.lon;

-- ---------------------------------------------------------------------------
-- Record the ground-truth discontinuity this migration creates.
--
-- `daily_aq` is a mean across the stations reporting in each hour, so adding
-- stations changes the measurement basis of a location's history at the moment
-- this runs -- with no change whatsoever in the actual air:
--
--   jakarta-central   2 stations -> 4
--   bsd               1 station  -> 4
--   bali-denpasar     1 station  -> 4
--
-- And the new stations do not agree with the old ones. The co-location check
-- at BMKG HQ puts the EPA-corrected AirGradient value ~+7.9 ug/m3 above the
-- reference BAM beside it, so each location's daily mean steps UP on the
-- changeover date.
--
-- Two things downstream are affected, and both are otherwise invisible:
--
--   1. Scoring. `prediction_scores` compares predictions issued before the
--      change against actuals measured after it, and `model_accuracy` averages
--      MAE over a rolling 30 days that straddles it. For ~30 days the board is
--      comparing models across two different definitions of "actual". Treat
--      rankings during that window as provisional.
--   2. Refitting. The wind model's coefficients were fitted on Nafas PM2.5,
--      which is a different instrument mix again. Any refit drawing on
--      post-change `daily_aq` is fitting a different target than v1 did.
--
-- Stamped onto the fitted coefficients so it travels with the model rather
-- than living only in a migration nobody re-reads. No-op on a fresh database
-- where coefficients are not seeded yet -- re-run this statement after
-- `npm run calibrate -- --write` if that is the order things happened in.
-- ---------------------------------------------------------------------------
update public.model_coefficients mc
set stats = mc.stats
  || jsonb_build_object(
       'station_mix_changed_at', current_date,
       'station_mix_note',
         'AirGradient stations added (migration 0006). daily_aq for this location '
         || 'is a mean over more stations from this date, and the added sensors read '
         || 'high relative to the reference BAM, so the ground-truth series steps up. '
         || 'Scores and MAE spanning this date compare two measurement bases.'
     )
from public.locations l
where l.id = mc.location_id
  and mc.is_active
  and l.slug in ('jakarta-central', 'bsd');
