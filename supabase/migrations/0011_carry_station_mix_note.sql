-- ===========================================================================
-- 0011 — carry 0006's station-mix annotation onto the active v2 coefficients.
--
-- APPLY ANY TIME. This writes only annotation keys. Nothing predict.ts reads
-- is touched: `resolveLagSpec` looks at `specification` and `lag_window_days`,
-- and neither appears here. A run between the deploy and this migration is
-- correct, merely less well documented.
--
-- ---------------------------------------------------------------------------
-- The blind spot
-- ---------------------------------------------------------------------------
-- 0009 and 0010 both carry a careful `stats` upsert clause: subtract the keys
-- the fit owns, then merge, so that a refit replaces its own measurements and
-- preserves annotations other migrations stamped. 0006 writes
-- `station_mix_changed_at` / `station_mix_note` onto jakarta-central and bsd
-- expressly so the note "this location's ground truth changed instrument mix
-- on date X" travels with the model rather than living in a migration nobody
-- re-reads.
--
-- That clause is correct and it did nothing, because it is an
-- `on conflict ... do update` clause and there was no conflict. 0009 and 0010
-- INSERTED version 2 for the first time, so `stats` is exactly the literal the
-- migration supplied — and the annotation stayed behind on the version 1 row,
-- which those same migrations had just deactivated.
--
-- Verified on the live database before writing this:
--
--   jakarta-central v1 keys: ... specification, station_mix_changed_at, station_mix_note
--   jakarta-central v2 keys: ... specification, lag_window_days, lag_definition_note
--
-- So the safety net protected a re-run and never covered the first write. The
-- drift test in tests/thresholds.test.ts had the matching blind spot: it
-- asserted the migration uses the merge FORM, which it does, and could not see
-- that the insert path inherits nothing. That test now also requires some
-- migration to carry these keys onto version 2 — which is this file, and which
-- would have failed before it existed.
--
-- ---------------------------------------------------------------------------
-- Why copy rather than re-state the note
-- ---------------------------------------------------------------------------
-- The text and the date are 0006's to define. Copying them forward from the
-- row that still holds them keeps one source of truth, and means a location
-- that never had the annotation does not acquire an invented one. A location
-- with no version 1 row, or whose version 1 never carried the stamp, is simply
-- not matched.
-- ---------------------------------------------------------------------------

begin;

update public.model_coefficients target
set stats = target.stats || src.carried
from (
  -- `distinct on` because the schema permits several versions per location and
  -- only one of them should win. Newest non-v2 version first: if the stamp was
  -- ever revised, the revision is the one worth keeping.
  select distinct on (location_id)
    location_id,
    -- strip_nulls so a row carrying the note but not the date contributes the
    -- note alone, rather than writing an explicit null over nothing.
    jsonb_strip_nulls(jsonb_build_object(
      'station_mix_changed_at', stats -> 'station_mix_changed_at',
      'station_mix_note',       stats -> 'station_mix_note'
    )) as carried
  from public.model_coefficients
  where model = 'wind_regression'
    and version <> 2
    and stats ? 'station_mix_note'
  order by location_id, version desc
) src
where target.location_id = src.location_id
  and target.model = 'wind_regression'
  and target.version = 2
  -- Idempotent, and deliberately non-destructive: a v2 row that already has
  -- the annotation — because a future seed learned to include it — is left
  -- exactly as it is. This migration only ever fills a gap.
  and not (target.stats ? 'station_mix_note');

commit;

-- ---------------------------------------------------------------------------
-- Verification — expect jakarta-central and bsd to show BOTH the rolling-lag
-- specification and the station-mix note on the same active row. The other
-- four locations correctly show no mix note: 0006 never stamped them, because
-- their station mix did not change.
-- ---------------------------------------------------------------------------
-- select l.slug,
--        mc.version,
--        mc.stats ->> 'specification'            as spec,
--        mc.stats ->> 'lag_window_days'          as window_days,
--        mc.stats ->> 'station_mix_changed_at'   as mix_changed_at,
--        left(mc.stats ->> 'station_mix_note', 40) as mix_note
-- from public.model_coefficients mc
-- join public.locations l on l.id = mc.location_id
-- where mc.model = 'wind_regression' and mc.is_active
-- order by l.slug;
