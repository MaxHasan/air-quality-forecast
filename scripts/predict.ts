/**
 * predict.ts — the four-model hybrid engine.
 *
 * Run:
 *   npm run predict                 # every location, horizons 1-3
 *   npm run predict -- --dry-run    # compute and print, write nothing
 *
 * Runs once a day at 12:37 UTC = 19:37 WIB (predict-score.yml), after the
 * rollup has landed today's partial actual — which this script reads, records,
 * and deliberately does not use. See "The day in progress" below.
 *
 * ---------------------------------------------------------------------------
 * Why four models and not one
 * ---------------------------------------------------------------------------
 * Every model writes a row for every location and horizon, every day, and
 * `model_accuracy` (0002_views.sql) ranks them on rolling 30-day MAE. The app
 * then shows whichever is actually winning *at that location and horizon*
 * rather than whichever seemed best during calibration. That matters because
 * the backtest in scripts/calibrate/fit-wind-model.ts found the ranking
 * inverts with horizon: naive persistence wins a day out, the wind regression
 * takes over further ahead. Crowning one model here would throw that away —
 * and the 2026-09 backtest is a second argument for the same discipline, since
 * the model it found strongest is the one with no coefficients at all.
 *
 *   persistence      the last COMPLETE daily mean, carried forward. The naive
 *                    benchmark, deliberately unimproved; daily PM2.5 is
 *                    strongly autocorrelated, which makes it much harder to
 *                    beat than it looks.
 *   rolling_mean     the mean of complete daily means over the trailing
 *                    ROLLING_MEAN_WINDOW_DAYS calendar days. Also carried
 *                    forward unchanged across horizons. No coefficients, which
 *                    is what lets it run for Bali and Singapore too.
 *   cams             Open-Meteo's CAMS PM2.5 forecast, aggregated to the target
 *                    local date. Physics, on a 40 km grid — coarse for a city.
 *   wind_regression  intercept + b_lag·(rolling mean of complete days)
 *                              + b_wind·(forecast daily-mean wind for the target)
 *                    The house model. Skipped where no coefficients are active.
 *
 * ---------------------------------------------------------------------------
 * The day in progress is never an input
 * ---------------------------------------------------------------------------
 * This is the correction shipped in 2026-09, and it is worth stating loudly
 * because the bug was invisible and ran nightly for months.
 *
 * The rollup writes TODAY's partial daily mean into `daily_aq` minutes before
 * this script runs. `readAnchor` used to scan newest-first for the first row
 * with `hours_count >= 12` — which from about midday WIB onward is always that
 * partial. So `persistence` was "today so far", and the regression's `pm25_lag`
 * was fed a ~19-hour mean while `b_lag` had been fitted on complete 24-hour
 * days. Train on the same source you will predict with; this project had
 * already learned that once, from BMKG-vs-Open-Meteo wind.
 *
 * Both anchors now come from `selectAnchors` (src/lib/rolling.ts), which the
 * calibration script also calls — one definition, two callers. Today's partial
 * is still READ, and recorded in `inputs.partial_today_pm25`, precisely so that
 * "this run saw a 19-hour mean and did not use it" is a fact in the data.
 *
 * ---------------------------------------------------------------------------
 * The lag window comes from the coefficient row, not from this file
 * ---------------------------------------------------------------------------
 * `b_lag` is only correct for the lag definition it was fitted on, so the
 * definition travels with the coefficients in `stats.lag_window_days`. If a row
 * asks for `pm25_lag` without declaring a window it is v1-shaped, and this
 * script SKIPS the model with the reason recorded rather than guessing — the
 * same discipline `applyCoefficients` applies to an unknown predictor name.
 *
 * That refusal is also what makes the migration ordering safe: 0009 applied
 * late means v1 rows are simply refused for a while, and the other three models
 * carry the night.
 *
 * `rolling_mean`'s window is resolved separately, from
 * ROLLING_MEAN_WINDOW_DAYS, because it has no coefficient row to read.
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
 * an honest absence rather than a fabricated opinion.
 *
 * Note the two cold starts are different and only one is visible. Bali and
 * Singapore lack a MODEL. The locations added by 0007 have a model but lack
 * SCORED HISTORY: `model_accuracy` has nothing for them until predictions
 * written from today are scored against actuals, so for the first
 * MIN_SCORED_DAYS_FOR_RANKING days their models are all unranked and the
 * headline falls back to MODEL_FALLBACK_ORDER rather than to a measured
 * winner. Their predictions are real from day one; the claim that one model is
 * beating the others is not, and the UI withholds it.
 *
 * `rolling_mean` starts in the second state EVERYWHERE, including at locations
 * that have been scored for months: it is new, so it has no scored days, and it
 * shows as unranked for its first MIN_SCORED_DAYS_FOR_RANKING days. It also has
 * a cold start of its own kind — it needs `minDays` complete days in its window
 * before it will emit at all, which at a brand-new location means roughly half
 * a window of ingestion.
 */

import { addLocalDays, localDayUtcRange, todayLocalDate } from '../src/lib/format';
import { lagSpec, resolveLagSpec, selectAnchors, type DailyMean } from '../src/lib/rolling';
import { MIN_HOURS_FOR_SCORING, ROLLING_MEAN_WINDOW_DAYS } from '../src/lib/stations';
import type {
  HorizonDays,
  IsoTimestamp,
  Json,
  LocalDate,
  ModelCoefficientMap,
  ModelFitStats,
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
  /** Carries `lag_window_days` — the definition `pm25_lag` was fitted on. */
  stats: ModelFitStats | null;
}

/**
 * How many recent daily means to read.
 *
 * Was 10, which was ample when the only question was "what is the newest day
 * with 12 hours?". It is not ample once a 7-day window can contain gaps: ten
 * rows newest-first covers ten CALENDAR days only if every one of them landed,
 * and the days most likely to be missing are exactly the ones that make the
 * window degrade. Reading a wider slice costs nothing and removes the
 * possibility that the limit itself silently truncates the window.
 */
const DAILY_MEANS_LIMIT = 40;

/**
 * Read recent daily means. The query, and no logic.
 *
 * All selection lives in `selectAnchors` (src/lib/rolling.ts) so that the
 * definition of "the level we already know" is shared with the calibration
 * script rather than reimplemented here. Reimplementing it here is how the
 * train/inference mismatch happened in the first place.
 */
async function readDailyMeans(locationId: number): Promise<DailyMean[]> {
  const db = serviceClient();
  const { data, error } = await db
    .from('daily_aq')
    .select('local_date, pm25_avg, hours_count')
    .eq('location_id', locationId)
    .order('local_date', { ascending: false })
    .limit(DAILY_MEANS_LIMIT)
    .returns<DailyMean[]>();

  if (error) throw new DbFailure(describeDbError('reading daily_aq for the prediction anchors', error));
  return data ?? [];
}

/** Active `wind_regression` coefficients, or `null` for a cold-start location. */
async function readCoefficients(locationId: number): Promise<ActiveCoefficients | null> {
  const db = serviceClient();
  const { data, error } = await db
    .from('model_coefficients')
    // `stats` is not decoration here: it carries `lag_window_days`, and
    // `resolveLagSpec` REFUSES a row that uses pm25_lag without declaring one.
    // Dropping it from this select would turn every v2 row into a v1-shaped
    // one and skip the model everywhere.
    .select('id, version, intercept, coef, stats')
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

  /* -- 1. anchors + coefficients (database) ------------------------------- */
  const dailyMeans = dryRun ? [] : await readDailyMeans(loc.id);
  const coefficients = dryRun ? null : await readCoefficients(loc.id);

  // `rolling_mean`'s window comes from a constant, not from the coefficients.
  // That is what lets it run for Bali and the five Singapore regions, which
  // have no coefficient row at all to read a window from.
  const rollingSpec = lagSpec(ROLLING_MEAN_WINDOW_DAYS, MIN_HOURS_FOR_SCORING);
  const naive = selectAnchors(dailyMeans, today, rollingSpec);
  const anchor = naive.anchor;

  // The regression's window comes from the COEFFICIENT ROW, because a slope is
  // only correct for the lag definition it was fitted on. A v1-shaped row —
  // pm25_lag with no declared window — is refused rather than guessed at.
  let lagged: ReturnType<typeof selectAnchors> | null = null;
  let lagSkip: string | null = null;
  if (coefficients) {
    const resolved = resolveLagSpec(coefficients.coef, coefficients.stats, MIN_HOURS_FOR_SCORING);
    if ('reason' in resolved) {
      lagSkip = `wind_regression: ${resolved.reason}`;
    } else if (resolved.spec === null) {
      // Coefficients that do not use pm25_lag at all (the old temp+wind
      // specification). Nothing to resolve; `applyCoefficients` handles it.
      lagged = null;
    } else {
      lagged = selectAnchors(dailyMeans, today, resolved.spec);
      if (!lagged.rolling) lagSkip = `wind_regression: ${lagged.skip?.reason ?? 'no rolling lag'}`;
    }
  }

  // Provenance shared by every row this run writes: what the run saw, including
  // the partial day it deliberately did not use.
  const runProvenance: PredictionInputs = {
    ...(naive.provenance.partialToday
      ? {
          partial_today_pm25: Number(naive.provenance.partialToday.pm25_avg.toFixed(3)),
          partial_today_hours: naive.provenance.partialToday.hours_count,
        }
      : {}),
  };

  if (!dryRun && naive.provenance.droppedRows > 0) {
    skips.push(`daily_aq: ${naive.provenance.droppedRows} row(s) dropped as future-dated or non-finite`);
  }
  if (lagSkip) skips.push(lagSkip);

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

    /* persistence — the last COMPLETE day, carried forward unchanged.
     *
     * Its only change this branch: `today` is excluded. It remains the naive
     * benchmark, deliberately unimproved, because the whole wind-vs-persistence
     * comparison rests on it being the same simple thing it has always been. */
    if (anchor) {
      rows.push(
        makePrediction(loc.id, targetDate, horizon, 'persistence', anchor.pm25_avg, {
          ...runProvenance,
          source_date: anchor.local_date,
          observed_hours: anchor.hours_count,
          anchor_age_days: anchor.ageDays,
          ...(anchor.thin ? { thin_anchor: true } : {}),
        }),
      );
    } else if (horizon === 1) {
      skips.push('persistence: no complete daily mean yet');
    }

    /* rolling_mean — the same value at every horizon, exactly as persistence
     * does. No coefficients, so it runs everywhere including Bali and
     * Singapore. */
    if (naive.rolling) {
      rows.push(
        makePrediction(loc.id, targetDate, horizon, 'rolling_mean', naive.rolling.value, {
          ...runProvenance,
          window_days: naive.rolling.windowDays,
          days_used: naive.rolling.daysUsed,
          gap_days: naive.rolling.gapDays,
          window_start: naive.rolling.windowStart,
          window_end: naive.rolling.windowEnd,
        }),
        // coefficients_id stays null — there is nothing fitted to point at.
      );
    } else if (horizon === 1) {
      skips.push(`rolling_mean: ${naive.skip?.reason ?? 'no rolling mean'}`);
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

    // Either the coefficients were refused as v1-shaped, or the window could
    // not be filled. Both were already recorded once, above.
    if (coefficients.coef.pm25_lag !== undefined && !lagged?.rolling) continue;

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
      // The ROLLING value, over the window this row's coefficients were fitted
      // on — never today's partial day, and never a window from a local
      // constant. See resolveLagSpec.
      pm25_lag: lagged?.rolling?.value ?? null,
    };

    const applied = applyCoefficients(coefficients, predictors);
    if ('missing' in applied) {
      skips.push(`wind_regression ${targetDate}: no value for ${applied.missing.join(', ')}`);
      continue;
    }

    const inputs: PredictionInputs = {
      ...runProvenance,
      wind_speed_avg_ms: day.windSpeedAvgMs ?? undefined,
      temp_avg_c: coefficients.coef.temp_avg_c === undefined ? undefined : (day.tempAvgC ?? undefined),
      ...(lagged?.rolling
        ? {
            pm25_lag: lagged.rolling.value,
            pm25_lag_window_days: lagged.rolling.windowDays,
            pm25_lag_days_used: lagged.rolling.daysUsed,
            pm25_lag_gap_days: lagged.rolling.gapDays,
            pm25_lag_window_start: lagged.rolling.windowStart,
            pm25_lag_window_end: lagged.rolling.windowEnd,
          }
        : {}),
      // Hours of the target day already elapsed at run time. Under the 19:37 WIB
      // schedule every horizon is entirely in the future, so this is 0 — the
      // field exists so an off-schedule run is distinguishable, not decorative.
      observed_hours: day.elapsedHours,
      forecast_hours: day.hours,
      forecast_fetched_at: fetchedAt,
      coefficients_version: coefficients.version,
      coefficients_predictors: Object.keys(coefficients.coef),
      coefficients_specification: coefficients.stats?.specification,
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
