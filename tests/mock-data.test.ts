/**
 * The fixture contract.
 *
 * These assert against `@/lib/mock-data` directly rather than through
 * `@/lib/data`, which since M4 defaults to the live Supabase reads and would
 * make this file a network test. The mock path through the seam is covered in
 * tests/queries.test.ts ("the data seam"); everything below is unchanged in
 * substance from when `data.ts` re-exported these functions.
 */
import { describe, expect, it } from 'vitest';
import {
  getDailyHistory,
  getHourlyPm25,
  getIngestionHealth,
  getLocationForecast,
  getLocationForecasts,
  getModelAccuracy,
} from '@/lib/mock-data';
import { LOCATIONS, MIN_HOURS_FOR_SCORING, MIN_SCORED_DAYS_FOR_RANKING } from '@/lib/stations';

describe('mock data seam', () => {
  it('returns one forecast per location, in LOCATIONS order', async () => {
    const forecasts = await getLocationForecasts();
    expect(forecasts.map((f) => f.location.slug)).toEqual(LOCATIONS.map((l) => l.slug));
  });

  it('gives calibrated-at-launch locations a wind_regression model and a non-calibrating headline', async () => {
    for (const slug of ['jakarta-central', 'bsd'] as const) {
      const f = await getLocationForecast(slug);
      expect(f).not.toBeNull();
      expect(f!.calibrating).toBe(false);
      expect(f!.models.map((m) => m.model)).toContain('wind_regression');
      expect(f!.headline).not.toBeNull();
      expect(f!.headline!.n).toBeGreaterThanOrEqual(MIN_SCORED_DAYS_FOR_RANKING);
    }
  });

  it('marks Bali and every Singapore location as calibrating, with no wind_regression', async () => {
    const calibratingSlugs = ['bali-denpasar', 'sg-central', 'sg-north', 'sg-south', 'sg-east', 'sg-west'] as const;
    for (const slug of calibratingSlugs) {
      const f = await getLocationForecast(slug);
      expect(f).not.toBeNull();
      expect(f!.calibrating).toBe(true);
      expect(f!.models.map((m) => m.model)).not.toContain('wind_regression');
    }
  });

  it('gives Bali thin-but-present ground truth (below MIN_HOURS_FOR_SCORING)', async () => {
    const f = await getLocationForecast('bali-denpasar');
    expect(f!.latest_actual).not.toBeNull();
    expect(f!.latest_actual!.hours_count).toBeLessThan(MIN_HOURS_FOR_SCORING);
  });

  it('gives sg-west a fully missing latest_actual (live outage)', async () => {
    const f = await getLocationForecast('sg-west');
    expect(f!.latest_actual).toBeNull();
    expect(f!.calibrating).toBe(true);
    // headline still resolves via MODEL_FALLBACK_ORDER cold-start fallback, not null.
    expect(f!.headline).not.toBeNull();
  });

  it('never fabricates mae/n below the ranking threshold', async () => {
    const forecasts = await getLocationForecasts();
    for (const f of forecasts) {
      for (const m of f.models) {
        if (m.n < MIN_SCORED_DAYS_FOR_RANKING) expect(m.mae).toBeNull();
        else expect(m.mae).not.toBeNull();
      }
    }
  });

  it('returns the requested number of hourly points, oldest first', async () => {
    const points = await getHourlyPm25('jakarta-central', 48);
    expect(points).toHaveLength(48);
    expect(new Date(points[0].observed_at).getTime()).toBeLessThan(new Date(points[47].observed_at).getTime());
  });

  it('has a visible recent gap in sg-west hourly PM2.5, but not in its wind', async () => {
    const points = await getHourlyPm25('sg-west', 24);
    const nullPm25Count = points.filter((p) => p.pm25_ugm3 === null).length;
    expect(nullPm25Count).toBeGreaterThan(0);
    expect(points.every((p) => p.wind_speed_ms !== null)).toBe(true);
  });

  it('returns 30 days of history plus a 3-day forecast fan', async () => {
    const daily = await getDailyHistory('jakarta-central');
    expect(daily).toHaveLength(33);
    const history = daily.slice(0, 30);
    const forecast = daily.slice(30);
    expect(history.every((d) => d.actual_pm25 !== null)).toBe(true);
    expect(forecast.every((d) => d.actual_pm25 === null)).toBe(true);
    expect(forecast.every((d) => 'wind_regression' in d.predicted && 'cams' in d.predicted && 'persistence' in d.predicted)).toBe(
      true,
    );
  });

  it('omits wind_regression from the forecast fan for calibrating locations', async () => {
    const daily = await getDailyHistory('sg-central');
    const forecast = daily.slice(30);
    expect(forecast.every((d) => !('wind_regression' in d.predicted))).toBe(true);
    expect(forecast.every((d) => 'cams' in d.predicted)).toBe(true);
  });

  it('excludes sg-west entirely from model_accuracy (zero scored days -> no view rows)', async () => {
    const rows = await getModelAccuracy();
    expect(rows.some((r) => r.location_slug === 'sg-west')).toBe(false);
    expect(rows.some((r) => r.location_slug === 'jakarta-central' && r.model === 'wind_regression')).toBe(true);
  });

  it('reproduces the backtest crossover: persistence leads at h=1, the wind model overtakes at h=2 and h=3', async () => {
    const rows = await getModelAccuracy();
    const at = (slug: string, horizon: number, model: string) =>
      rows.find((r) => r.location_slug === slug && r.horizon_days === horizon && r.model === model)!.mae;

    // Every location with a fitted wind model must tell the same story, not just
    // whichever one the fixture noise happened to favour.
    for (const slug of ['jakarta-central', 'bsd'] as const) {
      expect(at(slug, 1, 'persistence')).toBeLessThan(at(slug, 1, 'wind_regression'));
      expect(at(slug, 2, 'wind_regression')).toBeLessThan(at(slug, 2, 'persistence'));
      expect(at(slug, 3, 'wind_regression')).toBeLessThan(at(slug, 3, 'persistence'));
      // Persistence decays with horizon; the wind model barely moves. That
      // divergence, not a flat win, is what the crossover rests on.
      expect(at(slug, 3, 'persistence') - at(slug, 1, 'persistence')).toBeGreaterThan(
        at(slug, 3, 'wind_regression') - at(slug, 1, 'wind_regression'),
      );
      // CAMS is never the best call at any horizon — a 40 km grid over a city.
      for (const horizon of [1, 2, 3] as const) {
        expect(at(slug, horizon, 'cams')).toBeGreaterThan(at(slug, horizon, 'wind_regression'));
      }
    }
  });

  it('reports a non-trivial failure streak for the footer', async () => {
    const health = await getIngestionHealth();
    expect(health.failure_streak).toBeGreaterThan(0);
    expect(health.latest).not.toBeNull();
  });
});
