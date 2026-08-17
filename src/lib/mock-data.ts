/**
 * mock-data.ts — realistic fixtures typed exactly to the frontend composites
 * in `src/lib/types.ts`, for building the whole UI before the pipeline
 * (M2A/M3) has produced any live rows.
 *
 * `src/lib/data.ts` re-exports this module's functions under the exact
 * signatures the real Supabase-backed implementation will have. M4 swaps the
 * implementation of *those* functions; components never import from here
 * directly.
 *
 * Numbers are seeded (deterministic per process) rather than `Math.random()`,
 * so the same location shows consistent values across `/`, `/location/[slug]`
 * and `/models` within a single run — important because a mock that changes
 * on every request would make the UI look broken during review.
 *
 * Three deliberately-designed non-happy-path locations (per the M2B brief):
 *  - `bali-denpasar` and every `sg-*` location have no `wind_regression`
 *    coefficients (`calibratedAtLaunch: false` in stations.ts) — "calibrating".
 *  - `bali-denpasar` additionally has thin ground truth (1 station, 8 hours
 *    today) — present but degraded, not missing outright.
 *  - `sg-west` has a live station outage: no scored days at all (so it is
 *    absent from `model_accuracy` entirely — a real Postgres view would have
 *    no rows either), a null `latest_actual`, and a gap in its recent hourly
 *    and daily series. The footer's `IngestionHealth` explains why.
 */

import { toLocalHour, toLocalHourLabel, todayLocalDate, tomorrowLocalDate, addLocalDays } from './format';
import { LOCATIONS, locationBySlug, MIN_SCORED_DAYS_FOR_RANKING } from './stations';
import { pickHeadlineModel, isCalibrating } from './headline';
import { MODEL_FALLBACK_ORDER } from './types';
import type {
  DailyAqRow,
  DailyPoint,
  HourlyPoint,
  IngestionHealth,
  IngestionRunRow,
  LocalDate,
  LocationForecast,
  LocationRow,
  LocationSlug,
  ModelAccuracyRow,
  ModelName,
  ModelPrediction,
} from './types';

/* -------------------------------------------------------------------------- */
/* Deterministic PRNG                                                        */
/* -------------------------------------------------------------------------- */

/** xmur3 string hash -> 32-bit seed. */
function seedFromString(str: string): number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i += 1) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

/** mulberry32 PRNG — small, fast, good enough for fixture generation. */
function mulberry32(seed: number): () => number {
  let s = seed;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededRng(key: string): () => number {
  return mulberry32(seedFromString(key));
}

/** Standard-normal-ish noise via Box-Muller, scaled to `sd`. */
function gaussian(rnd: () => number, sd: number): number {
  const u1 = Math.max(rnd(), 1e-9);
  const u2 = rnd();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * sd;
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

function clamp(x: number, min: number, max = Number.POSITIVE_INFINITY): number {
  return Math.min(max, Math.max(min, x));
}

/* -------------------------------------------------------------------------- */
/* Time anchor                                                                */
/*                                                                            */
/* Computed once per process (module load) so every function call in the same */
/* dev/build run agrees on "now" — otherwise two RSC fetches a few ms apart    */
/* would generate visibly different numbers for the same location.           */
/* -------------------------------------------------------------------------- */

const ANCHOR_NOW = (() => {
  const d = new Date();
  d.setUTCMinutes(0, 0, 0);
  return d;
})();

/* -------------------------------------------------------------------------- */
/* Location fixtures                                                         */
/* -------------------------------------------------------------------------- */

const LOCATION_ROWS: Readonly<Record<LocationSlug, LocationRow>> = Object.freeze(
  Object.fromEntries(
    LOCATIONS.map((cfg, i) => [
      cfg.slug,
      {
        id: i + 1,
        slug: cfg.slug,
        name: cfg.name,
        country: cfg.country,
        timezone: cfg.timezone,
        lat: cfg.lat,
        lon: cfg.lon,
        created_at: '2026-06-01T00:00:00.000Z',
      } satisfies LocationRow,
    ]),
  ) as Record<LocationSlug, LocationRow>,
);

interface LocationProfile {
  /** Typical daily-mean PM2.5 at the location's characteristic wind speed. */
  pm25Base: number;
  /** Characteristic daily-mean wind speed, m/s. */
  windBase: number;
  /** µg/m³ removed per m/s of wind above `windBase` — the causal slope. */
  windSlope: number;
  /** Hour-to-hour diurnal wind swing amplitude. */
  windDiurnalAmp: number;
  /** Day-to-day slow "synoptic" wave amplitude (wind). */
  windRegimeAmp: number;
  windNoiseSdHourly: number;
  windNoiseSdDaily: number;
  pm25NoiseSdHourly: number;
  pm25NoiseSdDaily: number;
  trafficMorningAmp: number;
  trafficEveningAmp: number;
  /** CAMS' systematic bias vs. the wind model, µg/m³ (coarse 40 km grid). */
  camsBias: number;
  camsNoiseSd: number;
  windRegNoiseSd: number;
  /** Fraction of hourly PM2.5 readings randomly dropped (flaky single station etc.). */
  dropoutRate: number;
  /** Most recent N hours forced to null PM2.5 — an ongoing outage. */
  recentGapHours: number;
  /** Most recent N daily actuals forced to null — same outage, daily view. */
  recentGapDays: number;
  /** Ground-truth station count feeding the daily rollup on a normal day. */
  stationCount: number;
  /** Distinct local hours behind a normal day's rollup (out of 24). Below
   * MIN_HOURS_FOR_SCORING (12) marks a location as thin/degraded, not missing. */
  typicalHoursCount: number;
}

const PROFILES: Readonly<Record<LocationSlug, LocationProfile>> = {
  'jakarta-central': {
    pm25Base: 58,
    windBase: 2.6,
    windSlope: 4.4,
    windDiurnalAmp: 1.4,
    windRegimeAmp: 1.0,
    windNoiseSdHourly: 0.5,
    windNoiseSdDaily: 0.4,
    pm25NoiseSdHourly: 5,
    pm25NoiseSdDaily: 4.5,
    trafficMorningAmp: 9,
    trafficEveningAmp: 11,
    camsBias: 6,
    camsNoiseSd: 6,
    windRegNoiseSd: 2.6,
    dropoutRate: 0.02,
    recentGapHours: 0,
    recentGapDays: 0,
    stationCount: 2,
    typicalHoursCount: 24,
  },
  bsd: {
    pm25Base: 52,
    windBase: 2.8,
    windSlope: 4.1,
    windDiurnalAmp: 1.3,
    windRegimeAmp: 0.9,
    windNoiseSdHourly: 0.5,
    windNoiseSdDaily: 0.4,
    pm25NoiseSdHourly: 5,
    pm25NoiseSdDaily: 4.2,
    trafficMorningAmp: 7,
    trafficEveningAmp: 9,
    camsBias: 5,
    camsNoiseSd: 5.5,
    windRegNoiseSd: 2.8,
    dropoutRate: 0.02,
    recentGapHours: 0,
    recentGapDays: 0,
    stationCount: 1,
    typicalHoursCount: 24,
  },
  'bali-denpasar': {
    pm25Base: 27,
    windBase: 3.6,
    windSlope: 3.0,
    windDiurnalAmp: 1.6,
    windRegimeAmp: 0.8,
    windNoiseSdHourly: 0.6,
    windNoiseSdDaily: 0.5,
    pm25NoiseSdHourly: 4,
    pm25NoiseSdDaily: 3.5,
    trafficMorningAmp: 3,
    trafficEveningAmp: 4,
    camsBias: 3,
    camsNoiseSd: 5,
    windRegNoiseSd: 0, // no fitted model
    dropoutRate: 0.12, // single-station location — the weakest link in the map
    recentGapHours: 0,
    recentGapDays: 0,
    stationCount: 1,
    typicalHoursCount: 8, // thin: below MIN_HOURS_FOR_SCORING, degraded but present
  },
  'sg-central': sgProfile(24),
  'sg-north': sgProfile(22),
  'sg-south': sgProfile(25),
  'sg-east': sgProfile(23),
  'sg-west': { ...sgProfile(26), dropoutRate: 0.05, recentGapHours: 14, recentGapDays: 2 },
} as const;

function sgProfile(pm25Base: number): LocationProfile {
  return {
    pm25Base,
    windBase: 3.2,
    windSlope: 2.0,
    windDiurnalAmp: 1.2,
    windRegimeAmp: 0.7,
    windNoiseSdHourly: 0.5,
    windNoiseSdDaily: 0.4,
    pm25NoiseSdHourly: 3,
    pm25NoiseSdDaily: 2.8,
    trafficMorningAmp: 3,
    trafficEveningAmp: 3.5,
    camsBias: 2,
    camsNoiseSd: 3.5,
    windRegNoiseSd: 0,
    dropoutRate: 0.03,
    recentGapHours: 0,
    recentGapDays: 0,
    stationCount: 1,
    typicalHoursCount: 24,
  };
}

/* -------------------------------------------------------------------------- */
/* Wind + PM2.5 generators                                                   */
/* -------------------------------------------------------------------------- */

/** Diurnal wind: calm before dawn, peaking mid-afternoon (typical tropical coastal pattern). */
function windAtHour(hour: number, p: LocationProfile, rnd: () => number): number {
  const diurnal = p.windDiurnalAmp * Math.cos((2 * Math.PI * (hour - 15)) / 24);
  return clamp(p.windBase + diurnal + gaussian(rnd, p.windNoiseSdHourly), 0.2);
}

function trafficBump(hour: number, p: LocationProfile): number {
  const morning = p.trafficMorningAmp * Math.exp(-((hour - 7.5) ** 2) / (2 * 1.5 ** 2));
  const evening = p.trafficEveningAmp * Math.exp(-((hour - 18.5) ** 2) / (2 * 1.5 ** 2));
  return morning + evening;
}

function pm25AtHour(hour: number, wind: number, p: LocationProfile, rnd: () => number): number {
  const value = p.pm25Base - p.windSlope * (wind - p.windBase) + trafficBump(hour, p) + gaussian(rnd, p.pm25NoiseSdHourly);
  return clamp(value, 4);
}

/** Slow multi-day "synoptic" wave so the daily chart shows fronts passing through, not white noise. */
function regimeWave(dayIndex: number): number {
  return Math.sin((2 * Math.PI * dayIndex) / 9.5 + 0.6);
}

function windOnDay(dayIndex: number, p: LocationProfile, rnd: () => number): number {
  return clamp(p.windBase + p.windRegimeAmp * regimeWave(dayIndex) + gaussian(rnd, p.windNoiseSdDaily), 0.3);
}

function pm25OnDay(wind: number, p: LocationProfile, rnd: () => number): number {
  return clamp(p.pm25Base - p.windSlope * (wind - p.windBase) + gaussian(rnd, p.pm25NoiseSdDaily), 4);
}

/* -------------------------------------------------------------------------- */
/* Hourly series (last N hours, for the wind-overlay chart)                  */
/* -------------------------------------------------------------------------- */

const hourlyCache = new Map<string, HourlyPoint[]>();

function buildHourlySeries(slug: LocationSlug, hours: number): HourlyPoint[] {
  const cacheKey = `${slug}:${hours}`;
  const cached = hourlyCache.get(cacheKey);
  if (cached) return cached;

  const loc = locationBySlug(slug);
  const p = PROFILES[slug];
  if (!loc || !p) return [];

  const rnd = seededRng(`hourly:${slug}`);
  const points: HourlyPoint[] = [];

  for (let i = hours - 1; i >= 0; i -= 1) {
    const t = new Date(ANCHOR_NOW.getTime() - i * 3_600_000);
    const localHour = toLocalHour(t, loc.timezone) ?? 12;
    const wind = windAtHour(localHour, p, rnd);
    const isInGap = i < p.recentGapHours;
    const isDropped = !isInGap && rnd() < p.dropoutRate;
    const pm25 = isInGap || isDropped ? null : round1(pm25AtHour(localHour, wind, p, rnd));

    points.push({
      observed_at: t.toISOString(),
      local_label: toLocalHourLabel(t, loc.timezone) ?? '',
      pm25_ugm3: pm25,
      wind_speed_ms: round1(wind),
    });
  }

  hourlyCache.set(cacheKey, points);
  return points;
}

/* -------------------------------------------------------------------------- */
/* Daily series (history + forecast fan)                                     */
/* -------------------------------------------------------------------------- */

interface DailySeries {
  today: LocalDate;
  history: DailyPoint[]; // oldest -> today, inclusive
  forecast: DailyPoint[]; // tomorrow .. +3
  latestActual: DailyAqRow | null;
}

const dailyCache = new Map<LocationSlug, DailySeries>();

function buildDailySeries(slug: LocationSlug): DailySeries {
  const cached = dailyCache.get(slug);
  if (cached) return cached;

  const loc = locationBySlug(slug);
  const p = PROFILES[slug];
  const row = LOCATION_ROWS[slug];
  const today = todayLocalDate(loc?.timezone ?? 'Asia/Jakarta', ANCHOR_NOW);

  if (!loc || !p || !row || !today) {
    const empty: DailySeries = { today: today ?? '1970-01-01', history: [], forecast: [], latestActual: null };
    dailyCache.set(slug, empty);
    return empty;
  }

  const rnd = seededRng(`daily:${slug}`);
  const historyDays = 30;
  const history: DailyPoint[] = [];

  // dayIndex 0 == 29 days ago .. dayIndex 29 == today, ascending (oldest first).
  for (let dayIndex = 0; dayIndex < historyDays; dayIndex += 1) {
    const offsetFromToday = dayIndex - (historyDays - 1); // -29 .. 0
    const localDate = addLocalDays(today, offsetFromToday);
    if (!localDate) continue;

    const wind = windOnDay(dayIndex, p, rnd);
    const isInGap = -offsetFromToday < p.recentGapDays; // most recent N days
    const actual = isInGap ? null : round1(pm25OnDay(wind, p, rnd));

    history.push({
      local_date: localDate,
      actual_pm25: actual,
      wind_speed_avg_ms: round1(wind),
      predicted: {},
    });
  }

  // Continue the same deterministic day index sequence forward for the forecast fan.
  const forecast: DailyPoint[] = [];
  for (let h = 1; h <= 3; h += 1) {
    const dayIndex = historyDays - 1 + h;
    const localDate = addLocalDays(today, h);
    if (!localDate) continue;

    const wind = windOnDay(dayIndex, p, rnd);
    const predicted: Partial<Record<ModelName, number>> = {};

    if (p.windRegNoiseSd > 0) {
      // Its own (tighter) noise budget, not the "true" daily noise draw, so its
      // accuracy profile matches the model_accuracy fixture below.
      predicted.wind_regression = round1(
        clamp(p.pm25Base - p.windSlope * (wind - p.windBase) + gaussian(rnd, p.windRegNoiseSd), 4),
      );
    }
    predicted.cams = round1(clamp(p.pm25Base - p.windSlope * (wind - p.windBase) + p.camsBias + gaussian(rnd, p.camsNoiseSd), 4));

    forecast.push({ local_date: localDate, actual_pm25: null, wind_speed_avg_ms: round1(wind), predicted });
  }

  // Persistence: today's running average carried forward unchanged across all horizons —
  // deliberately naive, which is the point of shipping it as the benchmark to beat.
  const lastKnownActual = [...history].reverse().find((d) => d.actual_pm25 !== null)?.actual_pm25 ?? null;
  for (const f of forecast) {
    if (lastKnownActual !== null) f.predicted.persistence = lastKnownActual;
  }

  const todayPoint = history[history.length - 1];
  const latestActual: DailyAqRow | null =
    todayPoint && todayPoint.actual_pm25 !== null
      ? {
          location_id: row.id,
          local_date: todayPoint.local_date,
          pm25_avg: todayPoint.actual_pm25,
          pm25_min: round1(todayPoint.actual_pm25 * 0.7),
          pm25_max: round1(todayPoint.actual_pm25 * 1.35),
          hours_count: p.recentGapHours > 0 ? Math.max(0, 24 - p.recentGapHours) : p.typicalHoursCount,
          station_count: p.stationCount,
          computed_at: ANCHOR_NOW.toISOString(),
        }
      : null;

  const series: DailySeries = { today, history, forecast, latestActual };
  dailyCache.set(slug, series);
  return series;
}

/* -------------------------------------------------------------------------- */
/* Model accuracy (30-day skill per location x model x horizon)              */
/* -------------------------------------------------------------------------- */

/**
 * Base (horizon-1) MAE and per-horizon growth factor per model tier.
 *
 * These numbers used to show the wind model winning at every horizon. The
 * backtest in scripts/calibrate/fit-wind-model.ts found the opposite close in,
 * and it is the more interesting result: daily PM2.5 is strongly autocorrelated,
 * so naive persistence is very hard to beat one day out (Central Jakarta holdout:
 * 6.29 MAE against the hybrid's 7.41). What persistence cannot do is hold that
 * advantage — it decays fast with horizon while the wind model barely moves, so
 * the ranking inverts by h=2 and the gap widens at h=3.
 *
 * The fixtures are shaped to that finding rather than to the flattering version,
 * because a mock that quietly promises a win the real model does not deliver sets
 * expectations that production then has to disappoint. The per-horizon winner
 * selection in `model_accuracy` is what turns the crossover into an advantage —
 * which is precisely why all three models are shipped and scored.
 *
 *            h=1     h=2     h=3
 *   persist.  6.3     8.3    11.0     best close in, decays fastest
 *   wind      7.4     7.5     7.5     nearly flat — overtakes from h=2
 *   cams      8.6     9.4    10.2     coarse 40 km grid throughout
 */
const ACCURACY_TIER: Readonly<Record<ModelName, { baseMae: number; growth: number; baseRmseMult: number }>> = {
  wind_regression: { baseMae: 7.4, growth: 1.01, baseRmseMult: 1.28 },
  cams: { baseMae: 8.6, growth: 1.09, baseRmseMult: 1.22 },
  persistence: { baseMae: 6.3, growth: 1.32, baseRmseMult: 1.2 },
};

/** Scored-day counts per location — the thing that gates whether MAE is trustworthy. */
const SCORED_DAYS: Readonly<Record<LocationSlug, number>> = {
  'jakarta-central': 28,
  bsd: 24,
  'bali-denpasar': 4,
  'sg-central': 5,
  'sg-north': 3,
  'sg-south': 6,
  'sg-east': 2,
  'sg-west': 0, // live outage — no scored days at all; absent from the view entirely
};

function modelsForLocation(slug: LocationSlug): ModelName[] {
  const cfg = locationBySlug(slug);
  return cfg?.calibratedAtLaunch ? ['wind_regression', 'cams', 'persistence'] : ['cams', 'persistence'];
}

let cachedAccuracy: ModelAccuracyRow[] | null = null;

function buildModelAccuracy(): ModelAccuracyRow[] {
  if (cachedAccuracy) return cachedAccuracy;

  const rows: ModelAccuracyRow[] = [];

  for (const loc of LOCATIONS) {
    const n = SCORED_DAYS[loc.slug];
    if (n <= 0) continue; // no scored days -> no view row, for any model

    const row = LOCATION_ROWS[loc.slug];
    const today = todayLocalDate(loc.timezone, ANCHOR_NOW)!;
    const lastScored = addLocalDays(today, -1)!; // today isn't finished yet
    const firstScored = addLocalDays(lastScored, -(n - 1))!;

    // One wobble per *location*, shared by its models, rather than one per
    // (location, model). A location that is intrinsically harder to forecast is
    // harder for every model at once — and, more importantly here, a shared
    // multiplier cannot reorder the tiers, so the persistence-then-wind crossover
    // above holds at every location instead of being scrambled by ±15% noise.
    const wobble = 0.85 + seededRng(`accuracy-wobble:${loc.slug}`)() * 0.3;

    for (const model of modelsForLocation(loc.slug)) {
      const tier = ACCURACY_TIER[model];
      const rnd = seededRng(`accuracy:${loc.slug}:${model}`);

      for (const horizon of [1, 2, 3] as const) {
        const mae = round1(tier.baseMae * tier.growth ** (horizon - 1) * wobble);
        const rmse = round1(mae * tier.baseRmseMult);
        const bias = round1(gaussian(rnd, mae * 0.22));

        rows.push({
          location_id: row.id,
          location_slug: loc.slug,
          model,
          horizon_days: horizon,
          n,
          mae,
          rmse,
          bias,
          first_scored_date: firstScored,
          last_scored_date: lastScored,
        });
      }
    }
  }

  cachedAccuracy = rows;
  return rows;
}

/** `ModelPrediction[]` for a location: predicted values (tomorrow's forecast, horizon 1)
 * paired with the model's rolling skill, masked to `null` below the ranking threshold —
 * per the `ModelPrediction.mae` contract in types.ts. */
function buildModelPredictions(slug: LocationSlug): ModelPrediction[] {
  const { forecast } = buildDailySeries(slug);
  const tomorrow = forecast[0];
  if (!tomorrow) return [];

  const accuracy = buildModelAccuracy().filter((r) => r.location_slug === slug && r.horizon_days === 1);
  const byModel = new Map(accuracy.map((r) => [r.model, r]));

  const predictions: ModelPrediction[] = [];
  for (const model of MODEL_FALLBACK_ORDER) {
    const predicted = tomorrow.predicted[model];
    if (predicted === undefined) continue;
    const acc = byModel.get(model);
    const n = acc?.n ?? 0;
    predictions.push({
      model,
      predicted_pm25: predicted,
      horizon_days: 1,
      mae: acc && n >= MIN_SCORED_DAYS_FOR_RANKING ? acc.mae : null,
      n,
    });
  }
  return predictions;
}

/**
 * The call that was issued yesterday evening *for today* — the left half of the
 * card's today↔tomorrow comparison.
 *
 * Generated as today's underlying value plus the winning model's own error
 * profile, so "called 38, observed 33 so far" wobbles the way a real forecast
 * does. Anchored on the synthetic truth rather than the observed rollup,
 * because the forecast was made the night before regardless of whether the
 * stations later reported (sg-west's outage must not erase its prediction).
 */
function buildTodayPrediction(slug: LocationSlug): ModelPrediction | null {
  const p = PROFILES[slug];
  const { history } = buildDailySeries(slug);
  const todayPoint = history[history.length - 1];
  if (!p || !todayPoint) return null;

  const rnd = seededRng(`today-pred:${slug}`);
  const hasWindModel = p.windRegNoiseSd > 0;
  const model: ModelName = hasWindModel ? 'wind_regression' : 'cams';
  const noiseSd = hasWindModel ? p.windRegNoiseSd : p.camsNoiseSd;
  const bias = hasWindModel ? 0 : p.camsBias;

  const base =
    todayPoint.actual_pm25 ??
    pm25OnDay(todayPoint.wind_speed_avg_ms ?? p.windBase, p, rnd);

  const acc = buildModelAccuracy().find(
    (r) => r.location_slug === slug && r.model === model && r.horizon_days === 1,
  );
  const n = acc?.n ?? 0;

  return {
    model,
    predicted_pm25: round1(clamp(base + bias + gaussian(rnd, noiseSd), 4)),
    horizon_days: 1,
    mae: acc && n >= MIN_SCORED_DAYS_FOR_RANKING ? acc.mae : null,
    n,
  };
}

/* -------------------------------------------------------------------------- */
/* Ingestion health (footer)                                                 */
/* -------------------------------------------------------------------------- */

function buildIngestionHealth(): IngestionHealth {
  const latest: IngestionRunRow = {
    id: 4821,
    job: 'ingest-aq',
    started_at: new Date(ANCHOR_NOW.getTime() - 25 * 60_000).toISOString(),
    finished_at: new Date(ANCHOR_NOW.getTime() - 24 * 60_000).toISOString(),
    status: 'partial',
    rows_upserted: 34,
    error:
      'data.gov.sg west region: no readings for 14h (upstream outage). Badung Sempidi, Bali (waqi:-519205): stale on 3 of the last 5 polls.',
    meta: {
      failed_stations: ['datagovsg:west', 'waqi:-519205'],
      succeeded_stations: 9,
    },
  };

  return {
    last_ok_at: new Date(ANCHOR_NOW.getTime() - 2 * 3_600_000 - 25 * 60_000).toISOString(),
    failure_streak: 3,
    latest,
  };
}

/* -------------------------------------------------------------------------- */
/* Public seam — signatures the real (Supabase-backed) data.ts will mirror   */
/* -------------------------------------------------------------------------- */

export async function getLocationForecasts(): Promise<LocationForecast[]> {
  return Promise.all(LOCATIONS.map((cfg) => getLocationForecast(cfg.slug))).then(
    (list) => list.filter((f): f is LocationForecast => f !== null),
  );
}

export async function getLocationForecast(slug: LocationSlug): Promise<LocationForecast | null> {
  const row = LOCATION_ROWS[slug];
  if (!row) return null;

  const loc = locationBySlug(slug)!;
  const { today, latestActual } = buildDailySeries(slug);
  const targetDate = tomorrowLocalDate(loc.timezone, ANCHOR_NOW) ?? today;
  const models = buildModelPredictions(slug);

  return {
    location: row,
    target_date: targetDate,
    headline: pickHeadlineModel(models),
    models,
    latest_actual: latestActual,
    today_prediction: buildTodayPrediction(slug),
    calibrating: isCalibrating(models),
  };
}

const DEFAULT_HOURS = 24 * 7;

export async function getHourlyPm25(slug: LocationSlug, hours: number = DEFAULT_HOURS): Promise<HourlyPoint[]> {
  return buildHourlySeries(slug, hours);
}

export async function getDailyHistory(slug: LocationSlug): Promise<DailyPoint[]> {
  const { history, forecast } = buildDailySeries(slug);
  return [...history, ...forecast];
}

export async function getModelAccuracy(): Promise<ModelAccuracyRow[]> {
  return buildModelAccuracy();
}

export async function getIngestionHealth(): Promise<IngestionHealth> {
  return buildIngestionHealth();
}
