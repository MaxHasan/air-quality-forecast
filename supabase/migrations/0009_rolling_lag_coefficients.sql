-- ===========================================================================
-- 0009 — swap `wind_regression` to v2: the rolling-lag respecification.
--
-- APPLY THIS ONLY AFTER MERGING THE data-rolling-lag BRANCH AND DEPLOYING.
-- Late is safe; early is not. This is the OPPOSITE ordering to 0008, which
-- must go first. The reasoning is at the bottom of this header; if you are
-- applying these by hand, read it before running anything.
--
-- ---------------------------------------------------------------------------
-- What changed in the model
-- ---------------------------------------------------------------------------
-- v1:  PM2.5(target) = b0 + b_lag * PM2.5(one day)      + b_wind * wind(target)
-- v2:  PM2.5(target) = b0 + b_lag * PM2.5(7-day mean)   + b_wind * wind(target)
--
-- v1's coefficients were fitted on a COMPLETE previous calendar day, and
-- production fed them TODAY'S PARTIAL day: predict.ts runs at 12:37 UTC =
-- 19:37 WIB, after the rollup has written today's ~19-hour mean into daily_aq,
-- and `readAnchor` took the newest row clearing 12 hours — which from about
-- midday WIB onward is always that partial. A slope fitted on a 24-hour mean
-- was applied to a 19-hour one, every night, at every horizon.
--
-- v2 removes the mismatch by making both sides the same definition, and
-- `npm run calibrate -- --variants` chose the window rather than asserting it:
-- six lag definitions, two locations, three horizons, two fit geometries, on
-- the existing 80/20 chronological split. complete_7 / h1 won on mean holdout
-- hybrid MAE (9.466) with a 1.416 spread across shippable variants.
-- Full report: docs/backtests/2026-09-rolling-lag.md.
--
-- Seeds jakarta-central and bsd only — the two locations this branch refitted
-- and reported on. The other four TRAINABLE locations stay on v1 until the
-- follow-up described at the bottom.
--
-- ---------------------------------------------------------------------------
-- Why the statement order inside this file is forced
-- ---------------------------------------------------------------------------
-- `model_coefficients_single_active_idx` (0001_init.sql:176) is a partial
-- UNIQUE index on (location_id, model) where is_active, and it is NOT
-- deferrable. So "two active rows" is not a transient state this transaction
-- may pass through on its way to a valid one — it aborts at the statement.
--
-- Deactivate first, then insert active. One transaction, so a failure leaves
-- v1 active rather than leaving the location with no active coefficients at
-- all, which would silently drop wind_regression from the next run.
--
-- ---------------------------------------------------------------------------
-- Why `stats` is subtract-then-merge and never `= excluded.stats`
-- ---------------------------------------------------------------------------
-- `stats` carries two different kinds of thing: what a fit measured, and
-- annotations other migrations stamp on afterwards. 0006 writes
-- `station_mix_changed_at` / `station_mix_note` onto exactly these two
-- locations, expressly so "this location's ground truth changed instrument mix
-- on date X" travels with the model instead of living only in a migration
-- nobody re-reads.
--
-- A plain `stats = excluded.stats` deletes those. Applying 0007 wiped them
-- that way once already. A refit is not evidence the AirGradient discontinuity
-- did not happen — if anything it makes the note more load-bearing, because
-- the refit's training data predates the discontinuity entirely.
--
-- A plain `||` fixes that and introduces the mirror-image fault: a measured key
-- the fit STOPS emitting would keep its stale value forever, presented as
-- current. So: subtract the keys the fit owns, then merge. Same contract as
-- MEASURED_STATS_KEYS / mergeStats() in fit-wind-model.ts, and the key list
-- below is that constant rendered as a text[].
--
-- ---------------------------------------------------------------------------
-- WHY LATE IS SAFE AND EARLY IS NOT
-- ---------------------------------------------------------------------------
-- Late (new code, v1 rows still active): predict.ts calls resolveLagSpec,
-- sees `coef.pm25_lag` present with no `stats.lag_window_days`, recognises a
-- v1-shaped row and SKIPS wind_regression with the reason recorded in the run
-- log. The other three models carry the night. Visible, bounded, self-healing
-- the moment this file is applied.
--
-- Early (old code on main, v2 rows active): the old predict.ts does not check
-- `stats.specification` — it cannot, the key did not exist — so it reads v2 as
-- active and quietly feeds today's partial single-day anchor into a slope
-- fitted on a 7-day mean of complete days. That is this exact bug, inverted
-- and made worse: b_lag rises with the window (0.30 at W=1, 0.42 at W=7), so
-- the wrong input is multiplied by a larger coefficient. Nothing errors.
-- Nothing logs. The forecasts are simply wrong, and plausibly wrong.
--
-- The refusal in resolveLagSpec is what makes the late direction safe, and it
-- is why this file is separate from 0008 rather than appended to it.
--
-- ---------------------------------------------------------------------------
-- Merge-order hazard with other branches
-- ---------------------------------------------------------------------------
-- After this, jakarta-central and bsd are on v2 while jakarta-north,
-- jakarta-south, jakarta-west and bekasi are still on v1 — so those four have
-- wind_regression SKIPPED by the new code until a follow-up seeds them. That
-- is the designed degradation, not a defect, and it is visible in the run log.
--
-- Whichever branch lands next should re-run `npm run calibrate -- --sql`
-- across the full TRAINABLE list and ship the extension as 0010. The refit
-- already produces all six; only these two are seeded here because only these
-- two were reported on.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Deactivate every other wind_regression version, FIRST.
--    The partial unique index is not deferred: inserting an active v2 while v1
--    is still active aborts at that statement.
-- ---------------------------------------------------------------------------
update public.model_coefficients mc
set is_active = false
from public.locations l
where l.id = mc.location_id
  and mc.model = 'wind_regression'
  and mc.is_active
  and mc.version <> 2
  and l.slug in ('jakarta-central', 'bsd');

-- ---------------------------------------------------------------------------
-- 2. Seed v2 and make it active.
--
--    Joining `locations` on slug rather than hard-coding ids means an absent
--    slug produces no row instead of a foreign-key error — the 0006 pattern,
--    and what makes this safe on a database where 0004 has not run.
--
--    Generated by scripts/calibrate/fit-wind-model.ts on 2026-09-20 from
--    Nafas PM2.5 x ERA5 weather 2022-2023. Idempotent: re-running upserts v2.
-- ---------------------------------------------------------------------------
insert into public.model_coefficients (location_id, model, version, intercept, coef, stats, is_active)
select l.id, 'wind_regression', v.version, v.intercept, v.coef, v.stats, true
from (values
  ('jakarta-central', 2, 30.955052, '{"pm25_lag":0.577226,"wind_speed_avg_ms":-7.793468}'::jsonb, '{"r2":0.487568,"adj_r2":0.486111,"n":706,"rmse":9.1984,"period_start":"2022-01-01","period_end":"2023-12-14","source":"nafas-pm25 x era5-weather 2022-2023","specification":"rolling_pm25_lag + same_day_wind","lag_window_days":7,"lag_min_hours":12,"lag_min_days":4,"fit_geometry":"h1","holdout":{"h1":{"hybrid":8.14,"persistence":6.91,"rolling_mean":6.08},"h2":{"hybrid":8.12,"persistence":8.08,"rolling_mean":6.34},"h3":{"hybrid":8.19,"persistence":7.54,"rolling_mean":6.29}}}'::jsonb),
  ('bsd', 2, 46.022079, '{"pm25_lag":0.467308,"wind_speed_avg_ms":-11.291717}'::jsonb, '{"r2":0.483941,"adj_r2":0.482473,"n":706,"rmse":12.5665,"period_start":"2022-01-01","period_end":"2023-12-14","source":"nafas-pm25 x era5-weather 2022-2023","specification":"rolling_pm25_lag + same_day_wind","lag_window_days":7,"lag_min_hours":12,"lag_min_days":4,"fit_geometry":"h1","holdout":{"h1":{"hybrid":10.74,"persistence":10.93,"rolling_mean":8.86},"h2":{"hybrid":10.75,"persistence":11.52,"rolling_mean":8.96},"h3":{"hybrid":10.85,"persistence":10.95,"rolling_mean":9}}}'::jsonb)
) as v (location_slug, version, intercept, coef, stats)
join public.locations l on l.slug = v.location_slug
on conflict (location_id, model, version) do update set
  intercept = excluded.intercept,
  coef      = excluded.coef,
  -- Subtract the keys the fit owns, then merge. See the header.
  stats     = (coalesce(model_coefficients.stats, '{}'::jsonb) - array['r2', 'adj_r2', 'n', 'rmse', 'period_start', 'period_end', 'source', 'specification', 'holdout', 'lag_window_days', 'lag_min_hours', 'lag_min_days', 'fit_geometry']::text[]) || excluded.stats,
  is_active = excluded.is_active;

-- ---------------------------------------------------------------------------
-- 3. Annotate the switch, in the spirit of 0006's station-mix stamp.
--
--    A 30-day `model_accuracy` window straddling today contains scores from
--    both specifications under the single label `wind_regression`. Without
--    this note, a ranking computed across the boundary looks like one model
--    changing its mind rather than two models sharing a name.
--
--    Applied after the upsert so it annotates the row that now exists, and
--    scoped to v2 so it does not backdate the claim onto v1.
-- ---------------------------------------------------------------------------
update public.model_coefficients mc
set stats = mc.stats
  || jsonb_build_object(
       'lag_definition_changed_at', current_date,
       'lag_definition_note',
         'pm25_lag changed from a single day (v1) to the mean of complete days in '
         || '[issue-7, issue-1] (v2, migration 0009), and the coefficients were refitted '
         || 'on that definition. v1 was also fed today''s PARTIAL day at inference, which '
         || 'it was never fitted on. Scores and MAE spanning this date compare two '
         || 'different models under one label. See docs/backtests/2026-09-rolling-lag.md.'
     )
from public.locations l
where l.id = mc.location_id
  and mc.model = 'wind_regression'
  and mc.version = 2
  and l.slug in ('jakarta-central', 'bsd');

commit;

-- ---------------------------------------------------------------------------
-- Verification — expect exactly two rows, both version 2, both carrying
-- lag_window_days = 7 AND the station_mix_changed_at that 0006 stamped.
-- If station_mix_note is null here, the merge dropped an annotation and the
-- subtract-then-merge above is not doing what its header claims.
-- ---------------------------------------------------------------------------
-- select l.slug, mc.version, mc.is_active,
--        mc.stats ->> 'specification'    as spec,
--        mc.stats ->> 'lag_window_days'  as window_days,
--        mc.stats ->> 'station_mix_note' as mix_note
-- from public.model_coefficients mc
-- join public.locations l on l.id = mc.location_id
-- where mc.model = 'wind_regression' and mc.is_active
-- order by l.slug;
