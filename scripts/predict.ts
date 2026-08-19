/**
 * predict.ts — the three-model hybrid engine.
 *
 * Run:
 *   npm run predict                 # every location, horizons 1-3
 *   npm run predict -- --dry-run    # compute and print, write nothing
 *
 * Runs once a day at 12:37 UTC = 19:37 WIB (predict-score.yml), after the
 * rollup has landed today's partial actual.
 *
 * ---------------------------------------------------------------------------
 * Why three models and not one
 * ---------------------------------------------------------------------------
 * Every model writes a row for every location and horizon, every day, and
 * `model_accuracy` (0002_views.sql) ranks them on rolling 30-day MAE. The app
 * then shows whichever is actually winning *at that location and horizon*
 * rather than whichever seemed best during calibration. That matters because
 * the backtest in scripts/calibrate/fit-wind-model.ts found the ranking
 * inverts with horizon: naive persistence wins a day out, the wind regression
 * takes over further ahead. Crowning one model here would throw that away.
 *
 *   persistence      the last observed daily mean, carried forward. The
 *                    benchmark; daily PM2.5 is strongly autocorrelated, which
 *                    makes it much harder to beat than it looks.
 *   cams             Open-Meteo's CAMS PM2.5 forecast, aggregated to the target
 *                    local date. Physics, on a 40 km grid — coarse for a city.
 *   wind_regression  intercept + b_lag·(last observed daily mean)
 *                              + b_wind·(forecast daily-mean wind for the target)
 *                    The house model. Skipped where no coefficients are active.
 *
 * ---------------------------------------------------------------------------
 * Coefficients are read BY NAME
 * ---------------------------------------------------------------------------
 * `model_coefficients.coef` is a jsonb map from predictor name to slope, and
 * this script evaluates `intercept + Σ coef[name] · value(name)` over whatever
 * names it finds. The shipped v1 specification is `pm25_lag` + wind; an older
 * fit used `temp_avg_c` + wind. Reading by position would apply a temperature
 * slope to a lagged concentration and produce confident nonsense — the failure
 * would be invisible, because both are plausible-looking numbers.
 *
 * If a coefficient names a predictor this script cannot supply, the model is
 * skipped for that location with the reason recorded. Silently substituting
 * zero would be the same bug wearing a disguise.
 *
 * ---------------------------------------------------------------------------
 * Cold start
 * ---------------------------------------------------------------------------
 * All six Jabodetabek locations — the four Jakarta regions, BSD and Bekasi —
 * have a 2022-2023 Nafas archive to fit on, one CSV per city, so all six carry
 * active coefficients. Bali and the five Singapore regions have none, so
 * `wind_regression` writes nothing for them and the UI shows "calibrating" —
 * an honest absence rather than a fabricated third opinion.
 *
 * Note the two cold starts are different and only one is visible. Bali and
 * Singapore lack a MODEL. The locations added by 0007 have a model but lack
 * SCORED HISTORY: `model_accuracy` has nothing for them until predictions
 * written from today are scored against actuals, so for the first
 * MIN_SCORED_DAYS_FOR_RANKING days their three models are all unranked and the
 * headline falls back to MODEL_FALLBACK_ORDER rather than to a measured
 * winner. Their predictions are real from day one; the claim that one model is
 * beating the others is not, and the UI withholds it.
 */

import { addLocalDays, localDayUtcRange, todayLocalDate } from '../src/lib/format';
import { MIN_HOURS_FOR_SCORING } from '../src/lib/stations';
import type {
  HorizonDays,
  IsoTimestamp,
  Json,
  LocalDate,
  ModelCoefficientMap,
  ModelName,
  PredictionInputs,
  PredictionInsert,
  TimeZone,
} from '../src/lib/types';
import { aggregateDailyWeather, groupByLocalDate, type HourlyWeather } from './lib/aggregate';
import { DbFailure, describeDbError, loadLocations, serviceClient, upsertChunked, type LocationRecord } from './lib/db';
import { fetchJson, sleep } from './lib/http';
import { airQualityUrl, parseOpenMeteoAirQuality, parseOpenMeteoWeather, weatherUrl } from './lib/openmeteo';
import { hasFlag, reportFatal, runJob, type RunLog } from './lib/run-log';

const HORIZONS: readonly HorizonDays[] = [1, 2, 3] as const;

/**
 * Forecast days requested from both Open-Meteo endpoints.
 *
 * Horizon 3 needs the whole of `today + 3` in *local* time, which for UTC+7/+8
 * ends at 16:00-17:00 UTC on day 3 — inside a 4-day window. 5 is requested for
 * margin against a short response; the AQ endpoint caps at 7.
 */
const FORECAST_DAYS = 5;

/** Below this many hours, a forecast day's mean is too thin to build on. */
const MIN_FORECAST_HOURS = 18;

const DELAY_MS = 200;

/* -------------------------------------------------------------------------- */
/* Inputs                                                                     */
/* -------------------------------------------------------------------------- */

/** The most recent observed daily mean — persistence's answer and the model's anchor. */
interface Anchor {
  local_date: LocalDate;
  pm25_avg: number;
  hours_count: number;
}

/** One forecast day, derived from the Open-Meteo hourly arrays. */
interface ForecastDay {
  windSpeedAvgMs: number | null;
  tempAvgC: number | null;
  hours: number;
  /** Hours of this local day that had already elapsed when the run started. */
  elapsedHours: number;
}

/** The active coefficient row for a location, if there is one. */
interface ActiveCoefficients {
  id: number;
  version: number;
  intercept: number;
  coef: ModelCoefficientMap;
}

/**
 * Read the anchor: the newest daily mean with enough coverage to be trusted.
 *
 * Prefers a day with `hours_count >= 12` (the same bar `prediction_scores` uses
 * before it will score a model) and falls back to the newest day of any depth,
 * recording which it used. A thin anchor is worse than a stale one, but no
 * anchor at all means no persistence prediction and no regression either — so
 * the fallback exists, labelled.
 */
async function readAnchor(locationId: number): Promise<{ anchor: Anchor | null; thin: boolean }> {
  const db = serviceClient();
  const { data, error } = await db
    .from('daily_aq')
    .select('local_date, pm25_avg, hours_count')
    .eq('location_id', locationId)
    .order('local_date', { ascending: false })
    .limit(10)
    .returns<Anchor[]>();

  if (error) throw new DbFailure(describeDbError('reading daily_aq for the persistence anchor', error));

  const rows = data ?? [];
  const solid = rows.find((r) => r.hours_count >= MIN_HOURS_FOR_SCORING);
  if (solid) return { anchor: solid, thin: false };
  return { anchor: rows[0] ?? null, thin: rows.length > 0 };
}

/** Active `wind_regression` coefficients, or `null` for a cold-start location. */
async function readCoefficients(locationId: number): Promise<ActiveCoefficients | null> {
  const db = serviceClient();
  const { data, error } = await db
    .from('model_coefficients')
    .select('id, version, intercept, coef')
    .eq('location_id', locationId)
    .eq('model', 'wind_regression')
    .eq('is_active', true)
    // The schema enforces at most one active row per (location, model), so this
    // limit is belt and braces rather than a tie-break.
    .limit(1)
    .returns<ActiveCoefficients[]>();

  if (error) throw new DbFailure(describeDbError('reading model_coefficients', error));
  return data?.[0] ?? null;
}

/**
 * Aggregate an hourly forecast into per-local-date daily means.
 *
 * Reuses the same `aggregateDailyWeather` the rollup uses, so the wind figure
 * fed to the model at inference is computed exactly as the wind figure it was
 * fitted on — a mismatch there would bias every prediction by a constant nobody
 * could find.
 */
function forecastByLocalDate(hours: readonly HourlyWeather[], tz: TimeZone, now: Date): Map<LocalDate, ForecastDay> {
  const out = new Map<LocalDate, ForecastDay>();
  for (const [date, rows] of groupByLocalDate(hours, tz)) {
    const agg = aggregateDailyWeather(rows);
    if (!agg) continue;
    out.set(date, {
      windSpeedAvgMs: agg.wind_speed_avg_ms,
      tempAvgC: agg.temp_avg_c,
      hours: agg.hours_count,
      elapsedHours: rows.filter((r) => new Date(r.observed_at).getTime() <= now.getTime()).length,
    });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* The models                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Apply a coefficient map by name.
 *
 * Returns the reason rather than a number when a named predictor has no value,
 * so the caller can put "no wind forecast for 2026-08-19" in the log instead of
 * quietly writing a prediction that ignored the wind term.
 */
function applyCoefficients(
  coefficients: ActiveCoefficients,
  values: Readonly<Record<string, number | null>>,
): { value: number } | { missing: string[] } {
  let total = coefficients.intercept;
  const missing: string[] = [];

  for (const [name, slope] of Object.entries(coefficients.coef)) {
    if (typeof slope !== 'number' || !Number.isFinite(slope)) continue; // absent key
    const x = values[name];
    if (x === null || x === undefined || !Number.isFinite(x)) {
      missing.push(name);
      continue;
    }
    total += slope * x;
  }

  if (missing.length > 0) return { missing };
  return Number.isFinite(total) ? { value: total } : { missing: ['(non-finite result)'] };
}

/** Build one row, clamping at zero and recording the fact. */
function makePrediction(
  locationId: number,
  targetDate: LocalDate,
  horizon: HorizonDays,
  model: ModelName,
  raw: number,
  inputs: PredictionInputs,
  coefficientsId: number | null = null,
): PredictionInsert {
  // `predictions.predicted_pm25` has a `>= 0` CHECK, and a negative
  // concentration is meaningless anyway — but the clamp is *recorded*, because
  // a model drifting below zero is information about the model, not noise to
  // tidy away. src/lib/regression.ts deliberately leaves the clamping here.
  const clamped = raw < 0;
  return {
    location_id: locationId,
    target_date: targetDate,
    horizon_days: horizon,
    model,
    predicted_pm25: clamped ? 0 : raw,
    coefficients_id: coefficientsId,
    inputs: { ...inputs, ...(clamped ? { clamped: true, raw_prediction: Number(raw.toFixed(3)) } : {}) },
  };
}

/* -------------------------------------------------------------------------- */
/* Per location                                                               */
/* -------------------------------------------------------------------------- */

async function predictLocation(
  run: RunLog,
  loc: LocationRecord,
  now: Date,
  dryRun: boolean,
): Promise<PredictionInsert[]> {
  const tz = loc.timezone as TimeZone;
  const today = todayLocalDate(tz, now);
  if (!today) throw new Error(`could not determine today's date in ${tz}`);

  const fetchedAt: IsoTimestamp = now.toISOString();
  const rows: PredictionInsert[] = [];
  const skips: string[] = [];

  /* -- 1. anchor + coefficients (database) -------------------------------- */
  const { anchor, thin } = dryRun ? { anchor: null, thin: false } : await readAnchor(loc.id);
  const coefficients = dryRun ? null : await readCoefficients(loc.id);

  /* -- 2. weather forecast (Open-Meteo) ----------------------------------- */
  // `past_days=1` so the target-day window is fully covered even at the local
  // midnight boundary, where a local day begins in the previous UTC day.
  let windByDate = new Map<LocalDate, ForecastDay>();
  const wxRes = await fetchJson<unknown>(weatherUrl(loc.lat, loc.lon, 1, FORECAST_DAYS));
  if (!wxRes.ok) {
    skips.push(`weather forecast unavailable (${wxRes.message})`);
  } else {
    const parsed = parseOpenMeteoWeather(wxRes.data);
    if (!parsed.ok) skips.push(`weather forecast unparseable (${parsed.reason}: ${parsed.detail})`);
    else
      windByDate = forecastByLocalDate(
        parsed.hours.map((h) => ({
          observed_at: h.observedAt,
          temp_c: h.tempC,
          wind_speed_ms: h.windSpeedMs,
          wind_dir_deg: h.windDirDeg,
          rh_pct: h.rhPct,
          precip_mm: h.precipMm,
          blh_m: h.blhM,
        })),
        tz,
        now,
      );
  }

  /* -- 3. CAMS forecast (Open-Meteo air quality) -------------------------- */
  const camsByDate = new Map<LocalDate, { mean: number; hours: number }>();
  const aqRes = await fetchJson<unknown>(airQualityUrl(loc.lat, loc.lon, FORECAST_DAYS));
  if (!aqRes.ok) {
    skips.push(`CAMS forecast unavailable (${aqRes.message})`);
  } else {
    const parsed = parseOpenMeteoAirQuality(aqRes.data);
    if (!parsed.ok) {
      skips.push(`CAMS forecast unparseable (${parsed.reason}: ${parsed.detail})`);
    } else {
      const usable = parsed.hours.filter((h) => h.pm25 !== null);
      for (const [date, hours] of groupByLocalDate(
        usable.map((h) => ({ observed_at: h.observedAt, pm25: h.pm25 as number })),
        tz,
      )) {
        camsByDate.set(date, {
          mean: hours.reduce((a, h) => a + h.pm25, 0) / hours.length,
          hours: hours.length,
        });
      }
    }
  }

  /* -- 4. one row per model per horizon ----------------------------------- */
  for (const horizon of HORIZONS) {
    const targetDate = addLocalDays(today, horizon);
    if (!targetDate) continue;
    const window = localDayUtcRange(targetDate, tz);

    /* persistence */
    if (anchor) {
      rows.push(
        makePrediction(loc.id, targetDate, horizon, 'persistence', anchor.pm25_avg, {
          source_date: anchor.local_date,
          observed_hours: anchor.hours_count,
          ...(thin ? { thin_anchor: true } : {}),
        }),
      );
    } else if (horizon === 1) {
      skips.push('persistence: no observed daily mean yet');
    }

    /* cams */
    const cams = camsByDate.get(targetDate);
    if (cams && cams.hours >= MIN_FORECAST_HOURS) {
      rows.push(
        makePrediction(loc.id, targetDate, horizon, 'cams', cams.mean, {
          forecast_hours: cams.hours,
          forecast_fetched_at: fetchedAt,
          source: 'open-meteo cams global',
        }),
      );
    } else if (horizon === 1) {
      skips.push(`cams: ${cams ? `only ${cams.hours}h for ${targetDate}` : `no forecast hours for ${targetDate}`}`);
    }

    /* wind_regression */
    if (!coefficients) {
      // Expected for Bali and Singapore until ~90 scored days accumulate. Noted
      // once, at horizon 1, rather than three times.
      if (horizon === 1) skips.push('wind_regression: no active coefficients (calibrating)');
      continue;
    }

    const day = windByDate.get(targetDate);
    if (!day || day.hours < MIN_FORECAST_HOURS) {
      skips.push(`wind_regression: ${day ? `only ${day.hours}h of wind for ${targetDate}` : `no wind forecast for ${targetDate}`}`);
      continue;
    }

    // The predictor bag. Keys must match `model_coefficients.coef` keys, which
    // in turn match `daily_weather` column names — see the note in types.ts.
    const predictors: Record<string, number | null> = {
      wind_speed_avg_ms: day.windSpeedAvgMs,
      temp_avg_c: day.tempAvgC,
      pm25_lag: anchor?.pm25_avg ?? null,
    };

    const applied = applyCoefficients(coefficients, predictors);
    if ('missing' in applied) {
      skips.push(`wind_regression ${targetDate}: no value for ${applied.missing.join(', ')}`);
      continue;
    }

    const inputs: PredictionInputs = {
      wind_speed_avg_ms: day.windSpeedAvgMs ?? undefined,
      temp_avg_c: coefficients.coef.temp_avg_c === undefined ? undefined : (day.tempAvgC ?? undefined),
      pm25_lag: anchor?.pm25_avg,
      pm25_lag_date: anchor?.local_date,
      // Hours of the target day already elapsed at run time. Under the 19:37 WIB
      // schedule every horizon is entirely in the future, so this is 0 — the
      // field exists so an off-schedule run is distinguishable, not decorative.
      observed_hours: day.elapsedHours,
      forecast_hours: day.hours,
      forecast_fetched_at: fetchedAt,
      coefficients_version: coefficients.version,
      coefficients_predictors: Object.keys(coefficients.coef),
      target_window_start: window?.startIso,
      target_window_end: window?.endIso,
    };

    rows.push(makePrediction(loc.id, targetDate, horizon, 'wind_regression', applied.value, inputs, coefficients.id));
  }

  /* -- report ------------------------------------------------------------- */
  const summary = HORIZONS.map((h) => {
    const date = addLocalDays(today, h);
    const forHorizon = rows.filter((r) => r.horizon_days === h);
    const parts = forHorizon.map((r) => `${r.model.slice(0, 4)}=${r.predicted_pm25.toFixed(1)}`);
    return `h${h} ${date} [${parts.join(' ') || 'none'}]`;
  }).join('  ');
  console.log(`  ✓ ${loc.slug.padEnd(16)} ${summary}`);
  for (const s of skips) console.log(`      ~ ${s}`);
  if (skips.length > 0) run.note({ [`${loc.slug}_skipped`]: skips });

  return rows;
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = hasFlag(argv, 'dry-run');
  const now = new Date();

  await runJob('predict', { dryRun, meta: { horizons: [...HORIZONS] as unknown as Json } }, async (run) => {
    const locations: LocationRecord[] = dryRun
      ? (await import('../src/lib/stations')).LOCATIONS.map((l, i) => ({
          id: -(i + 1),
          slug: l.slug,
          timezone: l.timezone,
          lat: l.lat,
          lon: l.lon,
          name: l.name,
        }))
      : await loadLocations(serviceClient());

    if (dryRun) {
      console.log(
        '[predict] dry run — no database, so there is no persistence anchor and no\n' +
          '          coefficients. Only the `cams` model can produce a value; this\n' +
          '          exercises the Open-Meteo fetch, parse and local-date bucketing.',
      );
    }

    const all: PredictionInsert[] = [];
    for (const [i, loc] of locations.entries()) {
      if (i > 0) await sleep(DELAY_MS);
      try {
        all.push(...(await predictLocation(run, loc, now, dryRun)));
      } catch (err) {
        run.failed(`predict:${loc.slug}`, err);
      }
    }

    const byModel: Record<string, number> = {};
    for (const r of all) byModel[r.model] = (byModel[r.model] ?? 0) + 1;
    run.note({ predictions_by_model: byModel, locations: locations.length });

    if (dryRun) {
      run.upserted(all.length);
      console.log(`\n[dry run] would upsert ${all.length} prediction(s): ${JSON.stringify(byModel)}`);
      return;
    }

    if (all.length > 0) {
      run.upserted(
        await upsertChunked(
          'upserting predictions',
          serviceClient(),
          'predictions',
          all,
          'location_id,target_date,model,horizon_days',
        ),
      );
    }
  });
}

main().catch(reportFatal);
