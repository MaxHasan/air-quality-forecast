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
import {
  LOCATIONS,
  MIN_HOURS_FOR_SCORING,
  MIN_SCORED_DAYS_FOR_RANKING,
  ROLLING_MEAN_WINDOW_DAYS,
} from '@/lib/stations';

describe('mock data seam', () => {
  it('returns one forecast per location, in LOCATIONS order', async () => {
    const forecasts = await getLocationForecasts();
    expect(forecasts.map((f) => f.location.slug)).toEqual(LOCATIONS.map((l) => l.slug));
  });

  // Driven off `calibratedAtLaunch` rather than a hardcoded pair, so the six
  // Jabodetabek locations are covered without anyone remembering to add them.
  const CALIBRATED = LOCATIONS.filter((l) => l.calibratedAtLaunch).map((l) => l.slug);

  it('gives every calibrated-at-launch location a wind_regression model and no calibrating banner', async () => {
    // Guards against the filter silently matching nothing. Deliberately not
    // pinned to 6: `jakarta-east` arrives the day Jakarta Timur gets a feed
    // (0007's KNOWN GAPS), and bogor/depok/tangerang already have archives
    // waiting for a location. Growth should extend this test's reach, not
    // break it.
    expect(CALIBRATED.length).toBeGreaterThan(0);
    for (const slug of CALIBRATED) {
      const f = await getLocationForecast(slug);
      expect(f, slug).not.toBeNull();
      expect(f!.models.map((m) => m.model), slug).toContain('wind_regression');
      expect(f!.headline, slug).not.toBeNull();
      // A fitted model means the "no wind model fitted yet" banner must stay
      // down, INDEPENDENTLY of whether enough days have been scored to rank it.
      // The four locations added by 0007 are precisely the case that separates
      // those two questions: real coefficients, only days of scored history.
      expect(f!.calibrating, slug).toBe(false);
    }
  });

  it('separates "has a fitted model" from "has enough scored days to rank it"', async () => {
    // jakarta-central has both. jakarta-west has the first and not the second
    // — the state that used to be unrepresentable, and the one the mock's
    // calibrating rule got wrong until it was aligned with queries.ts.
    //
    // This case used to be pinned to jakarta-north, which was retired on
    // 2026-09-20 when its only feed died (see RETIRED_LOCATIONS). Any location
    // whose SCORED_DAYS sits below MIN_SCORED_DAYS_FOR_RANKING while carrying
    // fitted coefficients exercises the same state.
    const ranked = await getLocationForecast('jakarta-central');
    expect(ranked!.headline!.n).toBeGreaterThanOrEqual(MIN_SCORED_DAYS_FOR_RANKING);

    const unranked = await getLocationForecast('jakarta-west');
    expect(unranked!.calibrating).toBe(false);
    expect(unranked!.models.map((m) => m.model)).toContain('wind_regression');
    expect(unranked!.models.every((m) => m.n < MIN_SCORED_DAYS_FOR_RANKING)).toBe(true);
    // Unranked means MAE is withheld, not that the prediction is.
    expect(unranked!.models.every((m) => m.mae === null)).toBe(true);
    expect(unranked!.headline!.predicted_pm25).toBeGreaterThan(0);
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
    expect(
      forecast.every(
        (d) =>
          'wind_regression' in d.predicted &&
          'cams' in d.predicted &&
          'persistence' in d.predicted &&
          'rolling_mean' in d.predicted,
      ),
    ).toBe(true);
  });

  it('omits wind_regression from the forecast fan for calibrating locations', async () => {
    const daily = await getDailyHistory('sg-central');
    const forecast = daily.slice(30);
    expect(forecast.every((d) => !('wind_regression' in d.predicted))).toBe(true);
    expect(forecast.every((d) => 'cams' in d.predicted)).toBe(true);
    // rolling_mean needs no fit, so it IS present here. That asymmetry is the
    // reason the fourth model exists: these locations previously had only CAMS
    // and one naive benchmark.
    expect(forecast.every((d) => 'rolling_mean' in d.predicted)).toBe(true);
  });

  it('builds the forecast fan’s naive models from complete days only', async () => {
    // history[29] is today — partial, and the thing the 2026-09 fix stopped
    // using. persistence must carry history[28] forward, never history[29].
    const daily = await getDailyHistory('jakarta-central');
    const history = daily.slice(0, 30);
    const forecast = daily.slice(30);

    const today = history[29];
    const lastComplete = history[28];
    expect(today.actual_pm25).not.toBeNull();
    expect(lastComplete.actual_pm25).not.toBeNull();

    for (const f of forecast) {
      expect(f.predicted.persistence).toBe(lastComplete.actual_pm25);
      expect(f.predicted.persistence).not.toBe(today.actual_pm25);
    }

    // Both naive models are flat across the fan — one number carried forward.
    expect(new Set(forecast.map((f) => f.predicted.persistence)).size).toBe(1);
    expect(new Set(forecast.map((f) => f.predicted.rolling_mean)).size).toBe(1);

    // And the rolling mean sits inside the range of the days it averages,
    // which a mean must and a carried-forward single day need not.
    const window = history.slice(29 - ROLLING_MEAN_WINDOW_DAYS, 29).map((d) => d.actual_pm25 as number);
    const mean = forecast[0].predicted.rolling_mean as number;
    expect(mean).toBeGreaterThanOrEqual(Math.min(...window) - 0.05);
    expect(mean).toBeLessThanOrEqual(Math.max(...window) + 0.05);
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
    for (const slug of CALIBRATED) {
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

  it('keeps telling the rest of the story: rolling_mean leads at every horizon', async () => {
    // The 2026-09 backtest's headline finding
    // (docs/backtests/2026-09-rolling-lag.md): once persistence is scored
    // honestly against the last COMPLETE day, a plain 7-day mean beats every
    // other model at every horizon and both locations — including the wind
    // hybrid, and including an unattainable oracle single day.
    //
    // The fixtures have to carry that, because a mock that shows the wind model
    // winning sets an expectation production would then have to disappoint. It
    // is also why rolling_mean is worth a place on the board rather than a
    // courtesy line on a chart.
    const rows = await getModelAccuracy();
    const at = (slug: string, horizon: number, model: string) =>
      rows.find((r) => r.location_slug === slug && r.horizon_days === horizon && r.model === model)!.mae;

    for (const slug of CALIBRATED) {
      for (const horizon of [1, 2, 3] as const) {
        expect(at(slug, horizon, 'rolling_mean')).toBeLessThan(at(slug, horizon, 'persistence'));
        expect(at(slug, horizon, 'rolling_mean')).toBeLessThan(at(slug, horizon, 'wind_regression'));
        expect(at(slug, horizon, 'rolling_mean')).toBeLessThan(at(slug, horizon, 'cams'));
      }
      // Flattest of the four: a 7-day mean barely changes between issue dates a
      // day apart, so its error grows more slowly than persistence's.
      expect(at(slug, 3, 'rolling_mean') - at(slug, 1, 'rolling_mean')).toBeLessThan(
        at(slug, 3, 'persistence') - at(slug, 1, 'persistence'),
      );
    }
  });

  it('scores rolling_mean everywhere, including locations with no fitted wind model', async () => {
    const rows = await getModelAccuracy();
    // sg-west is the live-outage fixture with zero scored days, so it has no
    // view rows for any model.
    const scored = rows.filter((r) => r.location_slug !== 'sg-west');
    const slugs = [...new Set(scored.map((r) => r.location_slug))];

    for (const slug of slugs) {
      expect(
        scored.some((r) => r.location_slug === slug && r.model === 'rolling_mean'),
        `${slug} must carry rolling_mean`,
      ).toBe(true);
    }
    // And at least one of them genuinely has no wind model — otherwise this
    // test would pass without exercising the case it exists for.
    expect(slugs.some((s) => !scored.some((r) => r.location_slug === s && r.model === 'wind_regression'))).toBe(
      true,
    );
  });

  it('reports a non-trivial failure streak for the footer', async () => {
    const health = await getIngestionHealth();
    expect(health.failure_streak).toBeGreaterThan(0);
    expect(health.latest).not.toBeNull();
  });
});
