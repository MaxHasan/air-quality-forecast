/**
 * queries.ts — the live Supabase implementation of the six functions in
 * `src/lib/data.ts`, replacing the fixtures in `mock-data.ts` (milestone M4).
 *
 * Server-side only. Pages are RSC with `export const revalidate = 1800`, so the
 * cost of these reads is paid once per half hour per route, not per visitor —
 * which is why they are written as a handful of bulk queries rather than one
 * clever view.
 *
 * ---------------------------------------------------------------------------
 * Three rules this file follows throughout
 * ---------------------------------------------------------------------------
 *
 * 1. **Nothing here may throw.** A missing table (the schema not applied yet), an
 *    empty result (the normal state before the first predictions are scored) and
 *    a failed request all resolve to the same thing: the empty/degraded shape the
 *    components already know how to render. The dashboard degrading to "no data
 *    yet" is honest; a 500 on the home page because one view is empty is not.
 *    Every failure is logged server-side with enough context to find it.
 *
 * 2. **`.returns<T[]>()` on every select.** The `Database` type in `types.ts` is
 *    hand-written, so supabase-js cannot infer a select-string's result shape
 *    through it and collapses the row type to `never`. Pinning the shape is what
 *    keeps the compiler useful here. Same reason as
 *    `scripts/calibrate/fit-wind-model.ts`.
 *
 * 3. **Local dates come from `format.ts`, never from the database.** Every zone
 *    covered is ahead of UTC, so "today" in Jakarta is not "today" in UTC for
 *    seven hours of every day, and Bali (WITA) is an hour ahead of Jakarta again.
 *    `todayLocalDate(tz)` is the only thing allowed to answer that question.
 *
 * ---------------------------------------------------------------------------
 * On the two empty views
 * ---------------------------------------------------------------------------
 * `prediction_scores` and `model_accuracy` are joins, not tables: they populate
 * the moment a prediction's target date acquires an actual. Until the first
 * overlap lands, both are legitimately empty, so `getModelAccuracy()` returning
 * `[]` is the cold-start state and not an error. It means every model reports
 * `n = 0` and `mae = null`, `pickHeadlineModel` falls through to
 * `MODEL_FALLBACK_ORDER`, and `/models` shows its "needs scored days" copy.
 */

import { getAnonClient, type Db } from './db';
import { pickHeadlineModel, isCalibrating } from './headline';
import { LOCATIONS, locationBySlug, MIN_SCORED_DAYS_FOR_RANKING } from './stations';
import { addLocalDays, diffLocalDays, localDateRange, toLocalHourLabel, todayLocalDate } from './format';
import { MODEL_FALLBACK_ORDER } from './types';
import type {
  DailyAqRow,
  DailyPoint,
  HourlyPoint,
  IngestionHealth,
  IngestionRunRow,
  IsoTimestamp,
  LocalDate,
  LocationForecast,
  LocationRow,
  LocationSlug,
  ModelAccuracyRow,
  ModelName,
  ModelPrediction,
  TimeZone,
} from './types';

/* -------------------------------------------------------------------------- */
/* Tuning                                                                     */
/* -------------------------------------------------------------------------- */

const HOUR_MS = 3_600_000;

/** Default window of the hourly PM2.5 + wind chart: seven days. */
const DEFAULT_HOURS = 24 * 7;

/** Hard ceiling on a caller-supplied hour count, so one page cannot ask for a year. */
const MAX_HOURS = 24 * 92;

/** Days of actuals on the daily chart, before the forecast fan. Matches the mock. */
const HISTORY_DAYS = 30;

/** Horizons the predictor writes, and therefore the width of the forecast fan. */
const FORECAST_HORIZONS = [1, 2, 3] as const;

/** PostgREST caps an unbounded select at 1000 rows; page below that. */
const PAGE_SIZE = 900;

/** Job-log rows to inspect when computing the footer's failure streak. */
const RUN_LOG_WINDOW = 50;

/* -------------------------------------------------------------------------- */
/* Failure handling                                                           */
/* -------------------------------------------------------------------------- */

/** The error shape supabase-js hands back. Structurally typed to avoid the import. */
interface DbErrorLike {
  message: string;
  code?: string;
  details?: string | null;
  hint?: string | null;
}

/**
 * Log and swallow.
 *
 * `PGRST205` ("could not find the table in the schema cache") is the one worth
 * calling out by name: it means the migrations have not been applied, which is a
 * setup step rather than a bug, and it is otherwise indistinguishable from a
 * genuine outage in the logs.
 */
function logFailure(context: string, error: unknown): void {
  const e = (error ?? {}) as DbErrorLike;
  const message = e.message ?? String(error);
  const code = e.code ? ` [${e.code}]` : '';
  const detail = [e.details, e.hint].filter(Boolean).join(' ');
  const suffix =
    e.code === 'PGRST205' || e.code === '42P01'
      ? ' — the schema is not applied; run supabase/migrations/0001..0004 in the SQL editor'
      : '';
  console.error(`[data] ${context} failed${code}: ${message}${detail ? ` — ${detail}` : ''}${suffix}`);
}

/** The anon client, or `null` when the environment has no credentials. */
function client(): Db | null {
  try {
    return getAnonClient();
  } catch (error) {
    logFailure('creating the Supabase client', error);
    return null;
  }
}

type QueryResult<T> = PromiseLike<{ data: T[] | null; error: DbErrorLike | null }>;

/** Run one select, returning `[]` for every kind of failure. */
async function select<T>(context: string, build: (db: Db) => QueryResult<T>): Promise<T[]> {
  const db = client();
  if (!db) return [];
  try {
    const { data, error } = await build(db);
    if (error) {
      logFailure(context, error);
      return [];
    }
    return data ?? [];
  } catch (error) {
    logFailure(context, error);
    return [];
  }
}

/**
 * Run one select across as many pages as it takes.
 *
 * `build` is invoked per page because a PostgREST builder is a thenable and
 * cannot be re-executed — reusing one would return the first page forever. The
 * caller's query must carry a stable `.order()` or pages can overlap.
 */
async function selectAll<T>(context: string, build: (db: Db, from: number, to: number) => QueryResult<T>): Promise<T[]> {
  const db = client();
  if (!db) return [];
  const out: T[] = [];
  try {
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await build(db, from, from + PAGE_SIZE - 1);
      if (error) {
        logFailure(context, error);
        // Partial data beats none: the charts render gaps honestly.
        return out;
      }
      const page = data ?? [];
      out.push(...page);
      if (page.length < PAGE_SIZE) return out;
    }
  } catch (error) {
    logFailure(context, error);
    return out;
  }
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

function mean(xs: readonly number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function isFiniteNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

/** Whole hours since the epoch — the bucket key both hourly series share. */
function hourIndex(instant: IsoTimestamp | number | Date): number | null {
  const t = instant instanceof Date ? instant.getTime() : new Date(instant).getTime();
  return Number.isFinite(t) ? Math.floor(t / HOUR_MS) : null;
}

/* -------------------------------------------------------------------------- */
/* Row shapes read back from PostgREST                                        */
/* -------------------------------------------------------------------------- */

/** Only what a forecast card needs from `predictions`. */
interface PredictionSlim {
  location_id: number;
  target_date: LocalDate;
  horizon_days: number;
  model: ModelName;
  predicted_pm25: number;
}

interface HourlyAqRow {
  station_id: number;
  observed_at: IsoTimestamp;
  pm25_ugm3: number | null;
}

interface HourlyWindRow {
  observed_at: IsoTimestamp;
  wind_speed_ms: number | null;
}

interface DailyWindRow {
  local_date: LocalDate;
  wind_speed_avg_ms: number | null;
}

/* -------------------------------------------------------------------------- */
/* Reference reads                                                            */
/* -------------------------------------------------------------------------- */

/** Display order comes from `stations.ts`, not from the table's ids. */
const DISPLAY_ORDER = new Map<string, number>(LOCATIONS.map((l, i) => [l.slug, i]));

/**
 * Every seeded location, in card order.
 *
 * Rows whose slug is unknown to `stations.ts` are dropped rather than rendered:
 * without a registry entry there is no timezone to bucket their dates by, and a
 * card with the wrong local date is worse than a missing one. That can only
 * happen if a seed migration lands without the matching `stations.ts` edit, so
 * it is logged loudly.
 */
async function fetchLocations(): Promise<LocationRow[]> {
  const rows = await select<LocationRow>('reading locations', (db) =>
    db
      .from('locations')
      .select('id, slug, name, country, timezone, lat, lon, created_at')
      .order('id')
      .returns<LocationRow[]>(),
  );

  const known = rows.filter((r) => DISPLAY_ORDER.has(r.slug));
  if (known.length !== rows.length) {
    const unknown = rows.filter((r) => !DISPLAY_ORDER.has(r.slug)).map((r) => r.slug);
    console.error(`[data] locations has slug(s) absent from src/lib/stations.ts, skipped: ${unknown.join(', ')}`);
  }

  return known.sort((a, b) => (DISPLAY_ORDER.get(a.slug) ?? 0) - (DISPLAY_ORDER.get(b.slug) ?? 0));
}

async function fetchLocation(slug: LocationSlug): Promise<LocationRow | null> {
  const rows = await select<LocationRow>(`reading location ${slug}`, (db) =>
    db
      .from('locations')
      .select('id, slug, name, country, timezone, lat, lon, created_at')
      .eq('slug', slug)
      .limit(1)
      .returns<LocationRow[]>(),
  );
  return rows[0] ?? null;
}

/**
 * Station ids feeding a location.
 *
 * Inactive stations are included on purpose: a feed that went dormant last week
 * still measured real air the week before, and excluding it would punch a hole in
 * the history chart that never existed.
 */
async function fetchStationIds(locationId: number): Promise<number[]> {
  const rows = await select<{ id: number }>(`reading stations for location ${locationId}`, (db) =>
    db.from('stations').select('id').eq('location_id', locationId).order('id').returns<{ id: number }[]>(),
  );
  return rows.map((r) => r.id);
}

/** The location's timezone, from the registry (the DB column is a plain string). */
function timezoneFor(slug: string): TimeZone {
  return locationBySlug(slug)?.timezone ?? 'Asia/Jakarta';
}

/* -------------------------------------------------------------------------- */
/* getModelAccuracy                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The rolling 30-day skill board.
 *
 * Empty is the expected answer until predictions and actuals first overlap on a
 * date — see the header note. `/models` renders that as "no scored predictions
 * yet" per location rather than as a broken table.
 */
export async function getModelAccuracy(): Promise<ModelAccuracyRow[]> {
  return select<ModelAccuracyRow>('reading model_accuracy', (db) =>
    db
      .from('model_accuracy')
      .select('location_id, location_slug, model, horizon_days, n, mae, rmse, bias, first_scored_date, last_scored_date')
      .order('location_id')
      .order('horizon_days')
      .order('model')
      .returns<ModelAccuracyRow[]>(),
  );
}

/* -------------------------------------------------------------------------- */
/* getLocationForecast(s)                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Pair each model's freshest call for `targetDate` with its recent skill.
 *
 * **Takes the lowest available horizon rather than requiring horizon 1.**
 * A given date is predicted three times over three nights — as h3, then h2,
 * then h1 — so the row for tomorrow at h1 only exists once tonight's job has
 * run. Demanding h1 meant a single missed run blanked every card on the site,
 * while a perfectly good two-day-ahead call for that exact date sat unused in
 * the table. That is not hypothetical: GitHub's scheduler delays and drops
 * scheduled runs routinely, and it happened here the first day the site was
 * live.
 *
 * Lower horizons are strictly better — the forecast was issued closer to the
 * day and had more observed history behind it — so the minimum is always the
 * right pick, and `horizon_days` travels with the value so the UI can say how
 * far ahead it was made.
 *
 * The accuracy lookup uses that same horizon, because MAE is horizon-specific:
 * quoting h1 skill next to an h2 number would flatter it.
 *
 * `mae` is masked to `null` below `MIN_SCORED_DAYS_FOR_RANKING`, per the
 * `ModelPrediction.mae` contract in types.ts: a mean absolute error over three
 * days is a number, but it is not evidence, and showing it would invite the
 * reader to rank on it.
 */
function buildModelPredictions(
  location: LocationRow,
  targetDate: LocalDate,
  predictions: readonly PredictionSlim[],
  accuracy: readonly ModelAccuracyRow[],
): ModelPrediction[] {
  const out: ModelPrediction[] = [];

  for (const model of MODEL_FALLBACK_ORDER) {
    const candidates = predictions.filter(
      (p) =>
        p.location_id === location.id &&
        p.target_date === targetDate &&
        p.model === model &&
        isFiniteNumber(p.predicted_pm25),
    );
    if (candidates.length === 0) continue;

    const prediction = candidates.reduce((best, p) => (p.horizon_days < best.horizon_days ? p : best));
    const horizon = prediction.horizon_days;

    const acc = accuracy.find(
      (a) => a.location_slug === location.slug && a.model === model && a.horizon_days === horizon,
    );
    const n = acc?.n ?? 0;

    out.push({
      model,
      predicted_pm25: round1(prediction.predicted_pm25),
      horizon_days: (horizon >= 1 && horizon <= 3 ? horizon : 3) as ModelPrediction['horizon_days'],
      mae: acc && n >= MIN_SCORED_DAYS_FOR_RANKING ? acc.mae : null,
      n,
    });
  }

  return out;
}

/**
 * Assemble cards for a set of locations with one round of bulk queries.
 *
 * Every location is asked for *its own* tomorrow: Jakarta is UTC+7 while Bali and
 * Singapore are UTC+8, so for one hour each evening the two are different
 * calendar dates and a single shared target date would silently blank a card.
 */
async function assembleForecasts(locations: readonly LocationRow[]): Promise<LocationForecast[]> {
  if (locations.length === 0) return [];

  const today = new Map<number, LocalDate>();
  const target = new Map<number, LocalDate>();
  for (const loc of locations) {
    const tz = timezoneFor(loc.slug);
    const t = todayLocalDate(tz);
    if (!t) continue;
    today.set(loc.id, t);
    const tomorrow = addLocalDays(t, 1);
    if (tomorrow) target.set(loc.id, tomorrow);
  }

  const ids = locations.map((l) => l.id);
  const targetDates = [...new Set(target.values())];
  const todayDates = [...new Set(today.values())];

  const [accuracy, predictions, actuals] = await Promise.all([
    getModelAccuracy(),
    targetDates.length === 0
      ? Promise.resolve<PredictionSlim[]>([])
      : select<PredictionSlim>('reading predictions', (db) =>
          db
            .from('predictions')
            .select('location_id, target_date, horizon_days, model, predicted_pm25')
            .in('location_id', ids)
            .in('target_date', targetDates)
            // Deliberately NOT filtered to horizon 1 — buildModelPredictions
            // picks the lowest horizon present, so a target date still resolves
            // from an older, longer-range run when a nightly job is missed.
            // At most 3 horizons x 3 models x 8 locations, so fetching all of
            // them costs nothing.
            .order('horizon_days')
            .returns<PredictionSlim[]>(),
        ),
    todayDates.length === 0
      ? Promise.resolve<DailyAqRow[]>([])
      : select<DailyAqRow>('reading daily_aq', (db) =>
          db
            .from('daily_aq')
            .select('location_id, local_date, pm25_avg, pm25_min, pm25_max, hours_count, station_count, computed_at')
            .in('location_id', ids)
            .in('local_date', todayDates)
            .returns<DailyAqRow[]>(),
        ),
  ]);

  const out: LocationForecast[] = [];

  for (const location of locations) {
    const targetDate = target.get(location.id) ?? today.get(location.id);
    if (!targetDate) {
      logFailure(`resolving the local date for ${location.slug}`, { message: `unusable timezone on ${location.slug}` });
      continue;
    }

    const models = buildModelPredictions(location, targetDate, predictions, accuracy);

    // `latest_actual` is specifically *today's* rollup, because that is what the
    // card claims it is ("Today so far: …"). Falling back to yesterday's figure
    // would keep the line populated at the cost of making it a lie; an absent
    // row correctly renders as "the station feed is behind".
    const todayDate = today.get(location.id);
    const latestActual =
      actuals.find((a) => a.location_id === location.id && a.local_date === todayDate) ?? null;

    // `isCalibrating` asks "has any model earned enough scored days to be
    // ranked?". The copy behind this flag asks something narrower — "is there a
    // fitted wind model here yet?" — and under the fixtures the two coincided.
    // Against the live database they do not: `model_accuracy` is empty until the
    // first prediction is scored, so the scored-days test alone would put Jakarta
    // and BSD behind a banner announcing they have no wind model, which they do.
    // The flag therefore requires both to be true.
    const hasHouseModel = models.some((m) => m.model === 'wind_regression');

    out.push({
      location,
      target_date: targetDate,
      headline: pickHeadlineModel(models),
      models,
      latest_actual: latestActual,
      calibrating: isCalibrating(models) && !hasHouseModel,
    });
  }

  return out;
}

/** One card per location, in `LOCATIONS` display order. */
export async function getLocationForecasts(): Promise<LocationForecast[]> {
  return assembleForecasts(await fetchLocations());
}

/** One location's card, or `null` when the slug is not seeded (renders a 404). */
export async function getLocationForecast(slug: LocationSlug): Promise<LocationForecast | null> {
  const location = await fetchLocation(slug);
  if (!location) return null;
  const [forecast] = await assembleForecasts([location]);
  return forecast ?? null;
}

/* -------------------------------------------------------------------------- */
/* getHourlyPm25                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The last `hours` hours of PM2.5 and wind, one point per hour.
 *
 * The grid is built from the clock, not from the rows, so an hour nobody
 * measured is a `null` in the series rather than a missing x-value the chart
 * would silently close up. That matters right now: the Indonesian WAQI feeds have
 * a few hours of history while the Open-Meteo weather backfill has three months,
 * so this returns a full wind trace against a short PM2.5 one — which is exactly
 * what the chart should show.
 *
 * PM2.5 is averaged across a location's stations *within* the hour, matching
 * `aggregateDailyAq` in scripts/lib/aggregate.ts: one hour counts once, whoever
 * happened to measure it.
 */
export async function getHourlyPm25(slug: LocationSlug, hours: number = DEFAULT_HOURS): Promise<HourlyPoint[]> {
  const span = Number.isFinite(hours) ? Math.min(MAX_HOURS, Math.max(1, Math.floor(hours))) : DEFAULT_HOURS;

  const location = await fetchLocation(slug);
  if (!location) return [];
  const tz = timezoneFor(location.slug);

  const endHour = Math.floor(Date.now() / HOUR_MS);
  const startHour = endHour - (span - 1);
  const startIso = new Date(startHour * HOUR_MS).toISOString();
  // Half-open at the top: the next hour has not happened yet.
  const endIso = new Date((endHour + 1) * HOUR_MS).toISOString();

  const stationIds = await fetchStationIds(location.id);

  const [aqRows, windRows] = await Promise.all([
    stationIds.length === 0
      ? Promise.resolve<HourlyAqRow[]>([])
      : selectAll<HourlyAqRow>(`reading aq_observations for ${slug}`, (db, from, to) =>
          db
            .from('aq_observations')
            .select('station_id, observed_at, pm25_ugm3')
            .in('station_id', stationIds)
            .gte('observed_at', startIso)
            .lt('observed_at', endIso)
            .order('observed_at')
            .range(from, to)
            .returns<HourlyAqRow[]>(),
        ),
    selectAll<HourlyWindRow>(`reading weather_observations for ${slug}`, (db, from, to) =>
      db
        .from('weather_observations')
        .select('observed_at, wind_speed_ms')
        .eq('location_id', location.id)
        // One provider per series — blending two instruments' scales into one
        // line would make the wind trace meaningless.
        .eq('source', 'openmeteo')
        .gte('observed_at', startIso)
        .lt('observed_at', endIso)
        .order('observed_at')
        .range(from, to)
        .returns<HourlyWindRow[]>(),
    ),
  ]);

  const pm25ByHour = new Map<number, number[]>();
  for (const row of aqRows) {
    if (!isFiniteNumber(row.pm25_ugm3) || row.pm25_ugm3 < 0) continue;
    const h = hourIndex(row.observed_at);
    if (h === null) continue;
    const bucket = pm25ByHour.get(h);
    if (bucket) bucket.push(row.pm25_ugm3);
    else pm25ByHour.set(h, [row.pm25_ugm3]);
  }

  const windByHour = new Map<number, number>();
  for (const row of windRows) {
    if (!isFiniteNumber(row.wind_speed_ms)) continue;
    const h = hourIndex(row.observed_at);
    if (h === null) continue;
    windByHour.set(h, row.wind_speed_ms);
  }

  const points: HourlyPoint[] = [];
  for (let h = startHour; h <= endHour; h += 1) {
    const at = new Date(h * HOUR_MS);
    const values = pm25ByHour.get(h);
    const wind = windByHour.get(h);
    points.push({
      observed_at: at.toISOString(),
      local_label: toLocalHourLabel(at, tz) ?? '',
      pm25_ugm3: values && values.length > 0 ? round1(mean(values)) : null,
      wind_speed_ms: wind === undefined ? null : round1(wind),
    });
  }

  return points;
}

/* -------------------------------------------------------------------------- */
/* getDailyHistory                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Thirty days of actuals followed by the three-day forecast fan — the same 33
 * points the fixtures produced, so `DailyForecastChart` needs no changes.
 *
 * History days with no rollup keep `actual_pm25: null` instead of being dropped:
 * the chart draws real gaps (`connectNulls={false}`), and a compressed axis that
 * hides a missing week is the kind of quiet dishonesty this app exists to avoid.
 */
export async function getDailyHistory(slug: LocationSlug): Promise<DailyPoint[]> {
  const location = await fetchLocation(slug);
  if (!location) return [];

  const tz = timezoneFor(location.slug);
  const today = todayLocalDate(tz);
  if (!today) {
    logFailure(`resolving today for ${slug}`, { message: `unusable timezone ${tz}` });
    return [];
  }

  const historyStart = addLocalDays(today, -(HISTORY_DAYS - 1));
  const lastForecast = addLocalDays(today, FORECAST_HORIZONS[FORECAST_HORIZONS.length - 1]);
  if (!historyStart || !lastForecast) return [];

  const historyDates = localDateRange(historyStart, today);
  const forecastDates = FORECAST_HORIZONS.map((h) => addLocalDays(today, h)).filter((d): d is LocalDate => d !== null);

  const [actuals, winds, predictions] = await Promise.all([
    select<Pick<DailyAqRow, 'local_date' | 'pm25_avg'>>(`reading daily_aq for ${slug}`, (db) =>
      db
        .from('daily_aq')
        .select('local_date, pm25_avg')
        .eq('location_id', location.id)
        .gte('local_date', historyStart)
        .lte('local_date', today)
        .order('local_date')
        .returns<Pick<DailyAqRow, 'local_date' | 'pm25_avg'>[]>(),
    ),
    select<DailyWindRow>(`reading daily_weather for ${slug}`, (db) =>
      db
        .from('daily_weather')
        .select('local_date, wind_speed_avg_ms')
        .eq('location_id', location.id)
        .eq('source', 'openmeteo')
        .gte('local_date', historyStart)
        .lte('local_date', lastForecast)
        .order('local_date')
        .returns<DailyWindRow[]>(),
    ),
    forecastDates.length === 0
      ? Promise.resolve<PredictionSlim[]>([])
      : select<PredictionSlim>(`reading predictions for ${slug}`, (db) =>
          db
            .from('predictions')
            .select('location_id, target_date, horizon_days, model, predicted_pm25')
            .eq('location_id', location.id)
            .in('target_date', forecastDates)
            .returns<PredictionSlim[]>(),
        ),
  ]);

  const actualByDate = new Map(actuals.map((r) => [r.local_date, r.pm25_avg]));
  const windByDate = new Map(winds.map((r) => [r.local_date, r.wind_speed_avg_ms]));

  const points: DailyPoint[] = historyDates.map((local_date) => {
    const actual = actualByDate.get(local_date);
    const wind = windByDate.get(local_date);
    return {
      local_date,
      actual_pm25: isFiniteNumber(actual) ? round1(actual) : null,
      wind_speed_avg_ms: isFiniteNumber(wind) ? round1(wind) : null,
      predicted: {},
    };
  });

  for (const local_date of forecastDates) {
    // A prediction's horizon must match its distance from today, or it is a
    // leftover from an earlier run that named the same date at a longer lead —
    // three days of "tomorrow" stacked on one point.
    const horizon = diffLocalDays(today, local_date);
    const predicted: Partial<Record<ModelName, number>> = {};
    for (const p of predictions) {
      if (p.target_date !== local_date || p.horizon_days !== horizon) continue;
      if (!isFiniteNumber(p.predicted_pm25)) continue;
      predicted[p.model] = round1(p.predicted_pm25);
    }

    const wind = windByDate.get(local_date);
    points.push({
      local_date,
      actual_pm25: null,
      wind_speed_avg_ms: isFiniteNumber(wind) ? round1(wind) : null,
      predicted,
    });
  }

  return points;
}

/* -------------------------------------------------------------------------- */
/* getIngestionHealth                                                         */
/* -------------------------------------------------------------------------- */

/** Statuses that count against the streak. `running` is in-flight, not failed. */
function isFailure(status: IngestionRunRow['status']): boolean {
  return status === 'error' || status === 'partial';
}

/**
 * What the footer shows: when the pipeline was last clean, and whether the job
 * that ran most recently is in a run of failures.
 *
 * The streak is scoped to the most recent job's own history, per the
 * `IngestionHealth.failure_streak` contract — mixing jobs would let a healthy
 * weather ingest mask a repeatedly failing rollup, and vice versa.
 */
export async function getIngestionHealth(): Promise<IngestionHealth> {
  const runs = await select<IngestionRunRow>('reading ingestion_runs', (db) =>
    db
      .from('ingestion_runs')
      .select('id, job, started_at, finished_at, status, rows_upserted, error, meta')
      .order('started_at', { ascending: false })
      .limit(RUN_LOG_WINDOW)
      .returns<IngestionRunRow[]>(),
  );

  if (runs.length === 0) {
    return { last_ok_at: null, failure_streak: 0, latest: null };
  }

  const latest = runs[0];
  const lastOk = runs.find((r) => r.status === 'ok');

  let failureStreak = 0;
  for (const run of runs) {
    if (run.job !== latest.job) continue;
    if (run.status === 'running') continue;
    if (run.status === 'ok') break;
    if (isFailure(run.status)) failureStreak += 1;
  }

  return {
    last_ok_at: lastOk?.finished_at ?? lastOk?.started_at ?? null,
    failure_streak: failureStreak,
    latest,
  };
}
