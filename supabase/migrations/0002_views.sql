-- ============================================================================
-- 0002_views.sql — scoring, materialised by joins rather than by a write step.
--
-- As soon as scripts/rollup.ts lands yesterday's actual daily average, every
-- prediction that targeted that date becomes scored. There is no scoring job.
--
-- Both views are declared `security_invoker = true` (Postgres 15+, which
-- Supabase runs) so the row-level security of the underlying tables applies to
-- the *caller*, not the view owner. Without it a view is a silent RLS bypass.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- prediction_scores — every prediction whose target date now has an actual.
-- Days with thin coverage (<12 hours of observations) are excluded: scoring a
-- model against a 3-hour "daily average" would be noise.
-- ---------------------------------------------------------------------------
create or replace view public.prediction_scores
with (security_invoker = true) as
select
  p.id                                    as prediction_id,
  p.location_id,
  l.slug                                  as location_slug,
  p.target_date,
  p.horizon_days,
  p.model,
  p.predicted_pm25,
  d.pm25_avg                              as actual_pm25,
  (p.predicted_pm25 - d.pm25_avg)         as error,          -- signed: positive = over-predicted
  abs(p.predicted_pm25 - d.pm25_avg)      as abs_error,
  power(p.predicted_pm25 - d.pm25_avg, 2) as squared_error,
  d.hours_count                           as actual_hours_count,
  p.run_at
from public.predictions p
join public.locations l on l.id = p.location_id
join public.daily_aq  d on d.location_id = p.location_id
                       and d.local_date  = p.target_date
where d.hours_count >= 12;

comment on view public.prediction_scores is 'Predictions joined to actuals. Only days with >=12 hours of observations are scored.';

-- ---------------------------------------------------------------------------
-- model_accuracy — the "who is winning" board: MAE / RMSE / bias per
-- location × model × horizon over the trailing 30 days.
--
-- The frontend picks the headline model as the minimum `mae` at horizon_days=1
-- with n >= 7; below that it falls back to wind_regression -> cams ->
-- persistence (see src/lib/types.ts, ModelName).
--
-- `current_date` here is the database server's date (UTC). A ±1 day wobble on
-- the window edge is immaterial for a 30-day rolling average, and keeping the
-- filter in SQL avoids a per-location parameterised view.
-- ---------------------------------------------------------------------------
create or replace view public.model_accuracy
with (security_invoker = true) as
select
  s.location_id,
  s.location_slug,
  s.model,
  s.horizon_days,
  count(*)::int          as n,
  avg(s.abs_error)       as mae,
  sqrt(avg(s.squared_error)) as rmse,
  avg(s.error)           as bias,      -- systematic over/under-prediction
  min(s.target_date)     as first_scored_date,
  max(s.target_date)     as last_scored_date
from public.prediction_scores s
where s.target_date >= (current_date - interval '30 days')
group by s.location_id, s.location_slug, s.model, s.horizon_days;

comment on view public.model_accuracy is 'Rolling 30-day MAE/RMSE/bias per location x model x horizon. Drives the /models page and headline model selection.';
