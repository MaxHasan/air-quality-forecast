/**
 * queries.test.ts — the live (Supabase-backed) half of the data seam.
 *
 * Supabase is faked at the client boundary rather than at the HTTP one: the point
 * under test is the assembly logic — local-date bucketing, headline selection,
 * the hour grid, and above all the promise that *nothing here throws* — not
 * PostgREST's URL grammar.
 *
 * The fake honours the one structural fact these queries rely on: every builder
 * method chains, and the chain is a thenable that resolves to
 * `{ data, error }`. Which filters were applied is deliberately not asserted;
 * that would pin the tests to the query text rather than to behaviour.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCATIONS, MIN_SCORED_DAYS_FOR_RANKING } from '@/lib/stations';
import { addLocalDays, todayLocalDate } from '@/lib/format';
import { MODEL_FALLBACK_ORDER } from '@/lib/types';
import type { LocationSlug } from '@/lib/types';

/* -------------------------------------------------------------------------- */
/* The fake client                                                            */
/* -------------------------------------------------------------------------- */

type TableRows = Record<string, unknown[]>;

interface FakeOutcome {
  data: unknown[] | null;
  error: { message: string; code?: string } | null;
}

/** What the current test wants `getAnonClient()` to do. Reset in `beforeEach`. */
let respond: (table: string) => FakeOutcome = () => ({ data: [], error: null });
/** Set to throw from `getAnonClient()` itself (missing credentials). */
let clientThrows: Error | null = null;

vi.mock('@/lib/db', () => ({
  getAnonClient: () => {
    if (clientThrows) throw clientThrows;
    const chain = (table: string) => {
      const self = {
        select: () => self,
        eq: () => self,
        in: () => self,
        gte: () => self,
        gt: () => self,
        lte: () => self,
        lt: () => self,
        order: () => self,
        limit: () => self,
        range: () => self,
        returns: () => self,
        then: (onFulfilled: (v: FakeOutcome) => unknown, onRejected?: (e: unknown) => unknown) =>
          Promise.resolve()
            .then(() => respond(table))
            .then(onFulfilled, onRejected),
      };
      return self;
    };
    return { from: (table: string) => chain(table) };
  },
}));

/** Serve canned rows per table; any table not listed comes back empty. */
function serve(tables: TableRows): void {
  respond = (table) => ({ data: tables[table] ?? [], error: null });
}

/** Every table fails the way an unapplied schema does. */
function failWith(code: string, message: string): void {
  respond = () => ({ data: null, error: { code, message } });
}

const queries = await import('@/lib/queries');

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const locationRows = LOCATIONS.map((l, i) => ({
  id: i + 1,
  slug: l.slug,
  name: l.name,
  country: l.country,
  timezone: l.timezone,
  lat: l.lat,
  lon: l.lon,
  created_at: '2026-06-01T00:00:00.000Z',
}));

function idOf(slug: LocationSlug): number {
  return locationRows.find((l) => l.slug === slug)!.id;
}

function tzOf(slug: LocationSlug) {
  return LOCATIONS.find((l) => l.slug === slug)!.timezone;
}

function todayFor(slug: LocationSlug): string {
  return todayLocalDate(tzOf(slug))!;
}

function tomorrowFor(slug: LocationSlug): string {
  return addLocalDays(todayFor(slug), 1)!;
}

/** One horizon-1 prediction row. */
function prediction(slug: LocationSlug, model: string, value: number, horizon = 1, date?: string) {
  return {
    location_id: idOf(slug),
    target_date: date ?? addLocalDays(todayFor(slug), horizon)!,
    horizon_days: horizon,
    model,
    predicted_pm25: value,
  };
}

function dailyAq(slug: LocationSlug, local_date: string, pm25_avg: number, hours_count = 24, station_count = 1) {
  return {
    location_id: idOf(slug),
    local_date,
    pm25_avg,
    pm25_min: pm25_avg * 0.8,
    pm25_max: pm25_avg * 1.2,
    hours_count,
    station_count,
    computed_at: '2026-08-16T14:00:00.000Z',
  };
}

function accuracy(slug: LocationSlug, model: string, horizon: number, n: number, mae: number) {
  return {
    location_id: idOf(slug),
    location_slug: slug,
    model,
    horizon_days: horizon,
    n,
    mae,
    rmse: mae * 1.25,
    bias: 0.4,
    first_scored_date: '2026-07-18',
    last_scored_date: '2026-08-15',
  };
}

/** The state the project is actually in today: predictions written, nothing scored. */
function seedColdStart(): void {
  serve({
    locations: locationRows,
    stations: [{ id: 1 }, { id: 2 }],
    model_accuracy: [],
    predictions: [
      prediction('jakarta-central', 'persistence', 37.1),
      prediction('jakarta-central', 'cams', 51.8416666666667),
      prediction('jakarta-central', 'wind_regression', 37.707893115),
      prediction('bsd', 'persistence', 72.9),
      prediction('bsd', 'cams', 88.3291666666667),
      prediction('bsd', 'wind_regression', 65.21151577),
      prediction('sg-central', 'persistence', 31.17),
      prediction('sg-central', 'cams', 17.77),
    ],
    daily_aq: [
      dailyAq('jakarta-central', todayFor('jakarta-central'), 37.1, 1, 2),
      dailyAq('bsd', todayFor('bsd'), 72.9, 1, 1),
      dailyAq('sg-central', todayFor('sg-central'), 31.17, 23, 1),
    ],
  });
}

beforeEach(() => {
  clientThrows = null;
  respond = () => ({ data: [], error: null });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* -------------------------------------------------------------------------- */

describe('getLocationForecasts', () => {
  it('returns one card per location, in LOCATIONS display order', async () => {
    seedColdStart();
    const forecasts = await queries.getLocationForecasts();
    expect(forecasts.map((f) => f.location.slug)).toEqual(LOCATIONS.map((l) => l.slug));
  });

  it("targets each location's own tomorrow, in its own timezone", async () => {
    seedColdStart();
    const forecasts = await queries.getLocationForecasts();
    for (const f of forecasts) {
      expect(f.target_date).toBe(tomorrowFor(f.location.slug));
    }
  });

  it('falls back to MODEL_FALLBACK_ORDER for the headline when nothing is scored yet', async () => {
    seedColdStart();
    const jakarta = await queries.getLocationForecast('jakarta-central');
    // model_accuracy is empty, so no model is rankable and the cold-start
    // preference decides: wind_regression first.
    expect(jakarta!.headline!.model).toBe(MODEL_FALLBACK_ORDER[0]);
    expect(jakarta!.headline!.predicted_pm25).toBeCloseTo(37.7, 5);
    expect(jakarta!.models.map((m) => m.model)).toEqual(['wind_regression', 'cams', 'persistence']);
    expect(jakarta!.models.every((m) => m.mae === null && m.n === 0)).toBe(true);
  });

  it('ranks on MAE at horizon 1 once enough days are scored', async () => {
    serve({
      locations: locationRows,
      predictions: [
        prediction('jakarta-central', 'persistence', 37.1),
        prediction('jakarta-central', 'cams', 51.8),
        prediction('jakarta-central', 'wind_regression', 37.7),
      ],
      model_accuracy: [
        accuracy('jakarta-central', 'wind_regression', 1, 20, 7.4),
        accuracy('jakarta-central', 'cams', 1, 20, 8.6),
        accuracy('jakarta-central', 'persistence', 1, 20, 6.3),
      ],
    });
    const jakarta = await queries.getLocationForecast('jakarta-central');
    expect(jakarta!.headline!.model).toBe('persistence');
    expect(jakarta!.headline!.mae).toBe(6.3);
    expect(jakarta!.calibrating).toBe(false);
  });

  it('never surfaces an MAE below the ranking threshold', async () => {
    serve({
      locations: locationRows,
      predictions: [prediction('jakarta-central', 'cams', 51.8)],
      model_accuracy: [accuracy('jakarta-central', 'cams', 1, MIN_SCORED_DAYS_FOR_RANKING - 1, 4.2)],
    });
    const jakarta = await queries.getLocationForecast('jakarta-central');
    expect(jakarta!.models[0].n).toBe(MIN_SCORED_DAYS_FOR_RANKING - 1);
    expect(jakarta!.models[0].mae).toBeNull();
  });

  it('flags only the locations with no fitted wind model as calibrating', async () => {
    seedColdStart();
    const forecasts = await queries.getLocationForecasts();
    const bySlug = new Map(forecasts.map((f) => [f.location.slug, f]));
    // Jakarta and BSD have wind_regression rows even though nothing is scored.
    expect(bySlug.get('jakarta-central')!.calibrating).toBe(false);
    expect(bySlug.get('bsd')!.calibrating).toBe(false);
    expect(bySlug.get('sg-central')!.calibrating).toBe(true);
    expect(bySlug.get('sg-central')!.models.map((m) => m.model)).not.toContain('wind_regression');
  });

  it("uses today's rollup for latest_actual, and null when today has none", async () => {
    seedColdStart();
    const forecasts = await queries.getLocationForecasts();
    const bySlug = new Map(forecasts.map((f) => [f.location.slug, f]));

    const jakarta = bySlug.get('jakarta-central')!;
    expect(jakarta.latest_actual!.pm25_avg).toBe(37.1);
    expect(jakarta.latest_actual!.local_date).toBe(todayFor('jakarta-central'));
    expect(jakarta.latest_actual!.station_count).toBe(2);

    // sg-west has no daily_aq row at all — an honest gap, not a stale carry-over.
    expect(bySlug.get('sg-west')!.latest_actual).toBeNull();
  });

  it('ignores a stale rollup from a previous day rather than presenting it as today', async () => {
    const yesterday = addLocalDays(todayFor('bsd'), -1)!;
    serve({
      locations: locationRows,
      predictions: [prediction('bsd', 'cams', 88.3)],
      daily_aq: [dailyAq('bsd', yesterday, 60)],
    });
    const bsd = await queries.getLocationForecast('bsd');
    expect(bsd!.latest_actual).toBeNull();
  });

  it('returns null for a slug that is not seeded', async () => {
    serve({ locations: [] });
    expect(await queries.getLocationForecast('bali-denpasar')).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */

describe('getHourlyPm25', () => {
  it('returns exactly the requested number of hourly points, oldest first', async () => {
    serve({ locations: locationRows, stations: [{ id: 1 }] });
    const points = await queries.getHourlyPm25('jakarta-central', 48);
    expect(points).toHaveLength(48);
    expect(new Date(points[0].observed_at).getTime()).toBeLessThan(new Date(points[47].observed_at).getTime());
  });

  it('builds the grid from the clock, so unmeasured hours are nulls rather than missing points', async () => {
    const now = Math.floor(Date.now() / 3_600_000);
    serve({
      locations: locationRows,
      stations: [{ id: 1 }],
      // One PM2.5 reading, in the most recent hour only.
      aq_observations: [
        { station_id: 1, observed_at: new Date(now * 3_600_000).toISOString(), pm25_ugm3: 49.3 },
      ],
      // Wind for every hour of the window.
      weather_observations: Array.from({ length: 24 }, (_, i) => ({
        observed_at: new Date((now - 23 + i) * 3_600_000).toISOString(),
        wind_speed_ms: 2.5,
      })),
    });

    const points = await queries.getHourlyPm25('jakarta-central', 24);
    expect(points).toHaveLength(24);
    expect(points.every((p) => p.wind_speed_ms === 2.5)).toBe(true);
    expect(points.filter((p) => p.pm25_ugm3 !== null)).toHaveLength(1);
    expect(points[23].pm25_ugm3).toBe(49.3);
    expect(points.every((p) => /^\d{2}:00$/.test(p.local_label))).toBe(true);
  });

  it('averages across a location’s stations within the same hour', async () => {
    const now = Math.floor(Date.now() / 3_600_000);
    const at = new Date(now * 3_600_000).toISOString();
    serve({
      locations: locationRows,
      stations: [{ id: 1 }, { id: 2 }],
      aq_observations: [
        { station_id: 1, observed_at: at, pm25_ugm3: 49.3 },
        { station_id: 2, observed_at: at, pm25_ugm3: 24.9 },
      ],
    });
    const points = await queries.getHourlyPm25('jakarta-central', 2);
    expect(points[1].pm25_ugm3).toBe(37.1);
  });

  it('returns an empty series for an unknown location instead of a bare grid', async () => {
    serve({ locations: [] });
    expect(await queries.getHourlyPm25('sg-east', 24)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */

describe('getDailyHistory', () => {
  it('returns 30 days of history followed by the 3-day forecast fan', async () => {
    const today = todayFor('jakarta-central');
    serve({
      locations: locationRows,
      daily_aq: [dailyAq('jakarta-central', today, 37.1, 1, 2)],
      daily_weather: [{ local_date: today, wind_speed_avg_ms: 2.7695 }],
      predictions: [
        prediction('jakarta-central', 'persistence', 37.1, 1),
        prediction('jakarta-central', 'cams', 51.8416, 1),
        prediction('jakarta-central', 'wind_regression', 37.7078, 1),
        prediction('jakarta-central', 'wind_regression', 32.7005, 2),
        prediction('jakarta-central', 'wind_regression', 35.1536, 3),
      ],
    });

    const daily = await queries.getDailyHistory('jakarta-central');
    expect(daily).toHaveLength(33);

    const history = daily.slice(0, 30);
    const fan = daily.slice(30);
    expect(history[29].local_date).toBe(today);
    expect(history[29].actual_pm25).toBe(37.1);
    expect(history[29].wind_speed_avg_ms).toBe(2.8);
    expect(history.every((d) => Object.keys(d.predicted).length === 0)).toBe(true);
    expect(fan.every((d) => d.actual_pm25 === null)).toBe(true);
    expect(fan[0].predicted).toEqual({ persistence: 37.1, cams: 51.8, wind_regression: 37.7 });
    expect(fan[1].predicted).toEqual({ wind_regression: 32.7 });
    expect(fan[2].predicted).toEqual({ wind_regression: 35.2 });
  });

  it('keeps days with no rollup as explicit nulls rather than dropping them', async () => {
    serve({ locations: locationRows, daily_aq: [], daily_weather: [] });
    const daily = await queries.getDailyHistory('bsd');
    expect(daily).toHaveLength(33);
    expect(daily.every((d) => d.actual_pm25 === null)).toBe(true);
    // The dates are still a contiguous run, oldest first.
    for (let i = 1; i < daily.length; i += 1) {
      expect(daily[i].local_date).toBe(addLocalDays(daily[i - 1].local_date, 1));
    }
  });

  it('ignores a prediction whose horizon does not match its distance from today', async () => {
    const today = todayFor('bsd');
    serve({
      locations: locationRows,
      predictions: [
        // Yesterday's run, still naming tomorrow but at horizon 2 — carrying it
        // over would stack two different leads onto one point.
        prediction('bsd', 'cams', 99, 2, addLocalDays(today, 1)!),
        prediction('bsd', 'cams', 88.3, 1, addLocalDays(today, 1)!),
      ],
    });
    const daily = await queries.getDailyHistory('bsd');
    expect(daily[30].predicted).toEqual({ cams: 88.3 });
  });

  it('returns an empty series for an unknown location', async () => {
    serve({ locations: [] });
    expect(await queries.getDailyHistory('sg-north')).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */

describe('getModelAccuracy', () => {
  it('passes the view through unchanged', async () => {
    const rows = [accuracy('jakarta-central', 'wind_regression', 1, 20, 7.4)];
    serve({ model_accuracy: rows });
    expect(await queries.getModelAccuracy()).toEqual(rows);
  });

  it('treats an empty view as the cold-start state, not an error', async () => {
    serve({ model_accuracy: [] });
    expect(await queries.getModelAccuracy()).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */

describe('getIngestionHealth', () => {
  const run = (id: number, job: string, status: string, startedAt: string, error: string | null = null) => ({
    id,
    job,
    started_at: startedAt,
    finished_at: startedAt,
    status,
    rows_upserted: 0,
    error,
    meta: {},
  });

  it('reports a clean pipeline with no failure streak', async () => {
    serve({
      ingestion_runs: [
        run(5, 'ingest-weather', 'ok', '2026-08-16T14:32:19Z'),
        run(4, 'predict', 'ok', '2026-08-16T14:31:38Z'),
      ],
    });
    const health = await queries.getIngestionHealth();
    expect(health.failure_streak).toBe(0);
    expect(health.last_ok_at).toBe('2026-08-16T14:32:19Z');
    expect(health.latest!.id).toBe(5);
  });

  it('counts consecutive failures of the most recent job only', async () => {
    serve({
      ingestion_runs: [
        run(9, 'ingest-aq', 'partial', '2026-08-16T14:00:00Z', 'west region stale'),
        run(8, 'ingest-weather', 'ok', '2026-08-16T13:40:00Z'),
        run(7, 'ingest-aq', 'error', '2026-08-16T13:00:00Z'),
        run(6, 'ingest-aq', 'ok', '2026-08-16T12:00:00Z'),
        run(5, 'ingest-aq', 'error', '2026-08-16T11:00:00Z'),
      ],
    });
    const health = await queries.getIngestionHealth();
    // Two failures of ingest-aq, stopped by its own last clean run — the healthy
    // weather job in between neither breaks nor extends the streak.
    expect(health.failure_streak).toBe(2);
    expect(health.last_ok_at).toBe('2026-08-16T13:40:00Z');
    expect(health.latest!.job).toBe('ingest-aq');
  });

  it('does not count an in-flight run as a failure', async () => {
    serve({
      ingestion_runs: [
        run(3, 'rollup', 'running', '2026-08-16T14:00:00Z'),
        run(2, 'rollup', 'ok', '2026-08-16T13:00:00Z'),
      ],
    });
    expect((await queries.getIngestionHealth()).failure_streak).toBe(0);
  });

  it('degrades to an empty health report when there are no runs', async () => {
    serve({ ingestion_runs: [] });
    expect(await queries.getIngestionHealth()).toEqual({ last_ok_at: null, failure_streak: 0, latest: null });
  });
});

/* -------------------------------------------------------------------------- */

describe('graceful degradation', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  async function expectEverythingDegrades() {
    await expect(queries.getLocationForecasts()).resolves.toEqual([]);
    await expect(queries.getLocationForecast('jakarta-central')).resolves.toBeNull();
    await expect(queries.getHourlyPm25('jakarta-central', 24)).resolves.toEqual([]);
    await expect(queries.getDailyHistory('jakarta-central')).resolves.toEqual([]);
    await expect(queries.getModelAccuracy()).resolves.toEqual([]);
    await expect(queries.getIngestionHealth()).resolves.toEqual({
      last_ok_at: null,
      failure_streak: 0,
      latest: null,
    });
  }

  it('survives a missing table (schema not applied) without throwing', async () => {
    failWith('PGRST205', "Could not find the table 'public.locations' in the schema cache");
    await expectEverythingDegrades();
    expect(console.error).toHaveBeenCalled();
  });

  it('survives a request that rejects outright', async () => {
    respond = () => {
      throw new Error('fetch failed');
    };
    await expectEverythingDegrades();
  });

  it('survives missing credentials', async () => {
    clientThrows = new Error('Missing NEXT_PUBLIC_SUPABASE_ANON_KEY. See .env.example.');
    await expectEverythingDegrades();
  });

  it('logs the unapplied-schema hint rather than a bare error', async () => {
    failWith('PGRST205', "Could not find the table 'public.model_accuracy' in the schema cache");
    await queries.getModelAccuracy();
    const logged = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((c) => String(c[0]))
      .join('\n');
    expect(logged).toContain('PGRST205');
    expect(logged).toContain('supabase/migrations');
  });

  it('drops a location whose slug has no entry in stations.ts', async () => {
    serve({
      locations: [...locationRows, { ...locationRows[0], id: 99, slug: 'atlantis', timezone: 'Asia/Jakarta' }],
    });
    const forecasts = await queries.getLocationForecasts();
    expect(forecasts.map((f) => f.location.slug)).toEqual(LOCATIONS.map((l) => l.slug));
  });
});

/* -------------------------------------------------------------------------- */

describe('the data seam', () => {
  const original = process.env.USE_MOCK_DATA;

  afterEach(() => {
    if (original === undefined) delete process.env.USE_MOCK_DATA;
    else process.env.USE_MOCK_DATA = original;
  });

  it('defaults to the live implementation', async () => {
    delete process.env.USE_MOCK_DATA;
    const data = await import('@/lib/data');
    expect(data.isMockDataEnabled()).toBe(false);
    // The faked client serves nothing, so the live path yields nothing —
    // whereas the fixtures would always return eight cards.
    serve({ locations: [] });
    await expect(data.getLocationForecasts()).resolves.toEqual([]);
  });

  it('serves the fixtures when USE_MOCK_DATA is set', async () => {
    process.env.USE_MOCK_DATA = '1';
    const data = await import('@/lib/data');
    expect(data.isMockDataEnabled()).toBe(true);
    serve({ locations: [] });
    const forecasts = await data.getLocationForecasts();
    expect(forecasts).toHaveLength(LOCATIONS.length);
    expect(await data.getModelAccuracy()).not.toHaveLength(0);
  });

  it('accepts the other truthy spellings of the flag', async () => {
    const data = await import('@/lib/data');
    for (const value of ['1', 'true', 'TRUE', 'yes', 'on']) {
      process.env.USE_MOCK_DATA = value;
      expect(data.isMockDataEnabled()).toBe(true);
    }
    for (const value of ['0', 'false', '', 'no']) {
      process.env.USE_MOCK_DATA = value;
      expect(data.isMockDataEnabled()).toBe(false);
    }
  });
});
