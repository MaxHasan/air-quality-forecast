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
-- value + RH + formula id in `raw` so any reading can be re-derived if the
-- correction is ever revised. That same BMKG co-location pair doubles as a
-- standing calibration check (`npm run verify:colocation`).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Widen the source check. 0001 declared it inline on the column, so Postgres
-- auto-named it `stations_source_check` — but a DO block that finds the actual
-- constraint is safer than trusting an auto-generated name, because a silent
-- no-op drop would leave the old two-value check in place and every
-- 'airgradient' insert failing.
-- ---------------------------------------------------------------------------
do $$
declare
  con record;
begin
  for con in
    select conname
    from pg_constraint
    where conrelid = 'public.stations'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%source%in%'
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
-- Seed the stations verified live on 2026-08-18 (fresh-to-the-minute payloads,
-- coordinates from the API). Mapping rule: only stations within a sensible
-- radius of an existing location. Kedoya Utara (West Jakarta) and Permata
-- Hijau (South Jakarta) are live but seeded nowhere — no location exists for
-- them yet; add a location first if those areas ever matter.
--
--   jakarta-central:
--     84702   The Pakubuwono Menteng      — a few hundred meters from the
--                                           location's own coordinates
--     199980  BMKG 1                      — at BMKG HQ, next to the Kemayoran
--                                           reference BAM (waqi 8294): the
--                                           standing co-location cross-check
--   bsd (South Tangerang):
--     156518  British School Jakarta – Pondok Aren (Nafas)
--     156523  Global Jaya School – Parigi (Nafas)
--     74891   Ciputat (Nafas)
--   bali-denpasar:
--     77247   Tonja, Denpasar (Nafas)     — Denpasar proper
--     203332  Sibang Eco Village          — Badung, ~10 km north
--     203333  Canggu – Padang Linjong     — ~12 km northwest; kept because
--                                           Canggu is somewhere the household
--                                           actually goes
-- ---------------------------------------------------------------------------
insert into public.stations (location_id, source, source_station_id, name, network, lat, lon, is_active)
select l.id, 'airgradient', v.source_station_id, v.name, v.network, v.lat, v.lon, true
from (values
  ('jakarta-central', '84702',  'The Pakubuwono Menteng',                null,    -6.1861164, 106.8236334),
  ('jakarta-central', '199980', 'BMKG 1 (co-located with Kemayoran BAM)', null,   -6.1557694, 106.8423941),
  ('bsd',             '156518', 'British School Jakarta, Pondok Aren',   'nafas', -6.272408,  106.704339),
  ('bsd',             '156523', 'Global Jaya School, Parigi',            'nafas', -6.281047,  106.70024),
  ('bsd',             '74891',  'Ciputat',                               'nafas', -6.333194,  106.744433),
  ('bali-denpasar',   '77247',  'Tonja, Denpasar',                       'nafas', -8.6524,    115.2358),
  ('bali-denpasar',   '203332', 'Sibang Eco Village',                    null,    -8.5876,    115.2011),
  ('bali-denpasar',   '203333', 'Canggu, Padang Linjong',                null,    -8.6478,    115.1385)
) as v (location_slug, source_station_id, name, network, lat, lon)
join public.locations l on l.slug = v.location_slug
on conflict (source, source_station_id) do update set
  location_id = excluded.location_id,
  name        = excluded.name,
  network     = excluded.network,
  lat         = excluded.lat,
  lon         = excluded.lon;
