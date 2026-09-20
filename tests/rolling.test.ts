import { describe, expect, it } from 'vitest';
import { defaultMinDays, lagSpec, resolveLagSpec, selectAnchors, type DailyMean } from '@/lib/rolling';
import { MIN_HOURS_FOR_SCORING, ROLLING_MEAN_WINDOW_DAYS } from '@/lib/stations';
import { addLocalDays } from '@/lib/format';

/**
 * The bug these tests exist for.
 *
 * `predict.ts` ran at 19:37 WIB, after the rollup had written TODAY's ~19-hour
 * partial mean into `daily_aq`, and took the newest row with hours_count >= 12.
 * That is today's partial, every night. Meanwhile `fit-wind-model.ts` had
 * fitted b_lag on a COMPLETE previous calendar day. A slope fitted on a 24-hour
 * mean was being applied to a 19-hour one.
 *
 * Everything below is about one claim: there is now a single definition of the
 * lag, it excludes the day in progress, and both callers get the same answer
 * from it.
 */

const ASOF = '2026-09-20';

/** `hours` defaults to a complete day so each test states only what it is about. */
function day(local_date: string, pm25_avg: number, hours_count = 24): DailyMean {
  return { local_date, pm25_avg, hours_count };
}

/** Days counting back from `asOf`: `back(1)` is yesterday. */
const back = (n: number): string => addLocalDays(ASOF, -n) as string;

const W1 = lagSpec(1, MIN_HOURS_FOR_SCORING);
const W3 = lagSpec(3, MIN_HOURS_FOR_SCORING);
const W7 = lagSpec(7, MIN_HOURS_FOR_SCORING);

describe('selectAnchors — today is never an input', () => {
  it('excludes today’s partial row while still reporting it as provenance', () => {
    // THE REGRESSION THIS BRANCH EXISTS FOR. Today's 19-hour mean clears the
    // 12-hour bar, so the old readAnchor took it. It must now be ignored as an
    // input and recorded as a fact.
    const rows = [day(ASOF, 99, 19), day(back(1), 30), day(back(2), 20)];
    const sel = selectAnchors(rows, ASOF, W1);

    expect(sel.anchor?.local_date).toBe(back(1));
    expect(sel.anchor?.pm25_avg).toBe(30);
    expect(sel.rolling?.value).toBe(30);

    expect(sel.provenance.partialToday).toEqual({ local_date: ASOF, pm25_avg: 99, hours_count: 19 });
  });

  it('reports no partial when today has not been rolled up yet', () => {
    const sel = selectAnchors([day(back(1), 30)], ASOF, W1);
    expect(sel.provenance.partialToday).toBeNull();
  });

  it('excludes today even when it is the only row, and says why', () => {
    const sel = selectAnchors([day(ASOF, 99, 19)], ASOF, W1);
    expect(sel.anchor).toBeNull();
    expect(sel.rolling).toBeNull();
    expect(sel.skip?.code).toBe('no_rows');
  });
});

describe('selectAnchors — the completeness bar', () => {
  it('excludes a past day below 12 hours from the rolling window', () => {
    // back(2) is thin: the mean must be of back(1) and back(3) only.
    const rows = [day(back(1), 30), day(back(2), 100, 11), day(back(3), 20)];
    const sel = selectAnchors(rows, ASOF, W3);

    expect(sel.rolling?.value).toBeCloseTo(25, 10);
    expect(sel.rolling?.daysUsed).toBe(2);
    expect(sel.rolling?.gapDays).toBe(1);
  });

  it('accepts a day sitting exactly on the 12-hour bar', () => {
    const sel = selectAnchors([day(back(1), 30, MIN_HOURS_FOR_SCORING)], ASOF, W1);
    expect(sel.rolling?.value).toBe(30);
  });
});

describe('selectAnchors — W=1 is exactly “the last complete day”', () => {
  it('equals the naive complete-day anchor', () => {
    // Pins the relationship the accuracy board will display between
    // `persistence` and a one-day `rolling_mean`: at W=1 they are the same
    // number, so a divergence there is a bug and not a modelling choice.
    const rows = [day(ASOF, 99, 19), day(back(1), 31.5), day(back(2), 20), day(back(3), 10)];
    const sel = selectAnchors(rows, ASOF, W1);

    expect(sel.rolling?.value).toBe(sel.anchor?.pm25_avg);
    expect(sel.rolling?.value).toBe(31.5);
    expect(sel.rolling?.windowStart).toBe(back(1));
    expect(sel.rolling?.windowEnd).toBe(back(1));
    expect(sel.rolling?.gapDays).toBe(0);
  });
});

describe('selectAnchors — the window is a calendar span, not a quota', () => {
  it('averages the span and does NOT reach past asOf−W to fill a gap', () => {
    // back(2) is missing entirely. A quota-filling implementation would walk
    // back to back(4) and call the result a 3-day mean; that is a different
    // estimator from the one b_lag was fitted on, and it would differ only on
    // the days the feed was unhealthy.
    const rows = [day(back(1), 30), day(back(3), 20), day(back(4), 1000), day(back(5), 1000)];
    const sel = selectAnchors(rows, ASOF, W3);

    expect(sel.rolling?.value).toBeCloseTo(25, 10);
    expect(sel.rolling?.daysUsed).toBe(2);
    expect(sel.rolling?.gapDays).toBe(1);
    expect(sel.rolling?.windowStart).toBe(back(3));
    expect(sel.rolling?.windowEnd).toBe(back(1));
  });

  it('reports a full window as zero gap days', () => {
    const rows = [1, 2, 3, 4, 5, 6, 7].map((n) => day(back(n), 10 * n));
    const sel = selectAnchors(rows, ASOF, W7);
    expect(sel.rolling?.daysUsed).toBe(7);
    expect(sel.rolling?.gapDays).toBe(0);
    expect(sel.rolling?.value).toBeCloseTo(40, 10); // mean of 10..70
  });
});

describe('selectAnchors — refusal below minDays', () => {
  it('derives minDays as half the window, at least one', () => {
    expect(defaultMinDays(1)).toBe(1);
    expect(defaultMinDays(3)).toBe(2);
    expect(defaultMinDays(7)).toBe(4);
  });

  it('refuses when too few complete days are in the span', () => {
    // W=7 needs 4; only 3 are present.
    const rows = [day(back(1), 30), day(back(2), 20), day(back(3), 10)];
    const sel = selectAnchors(rows, ASOF, W7);

    expect(sel.rolling).toBeNull();
    expect(sel.skip?.code).toBe('below_min_days');
    expect(sel.skip?.reason).toContain('below the minimum of 4');
    // The naive anchor still works — the models degrade independently.
    expect(sel.anchor?.pm25_avg).toBe(30);
  });

  it('distinguishes “no rows at all” from “rows but none complete”', () => {
    const empty = selectAnchors([], ASOF, W3);
    expect(empty.skip?.code).toBe('no_rows');
    expect(empty.skip?.reason).toContain('no daily mean at all');

    const thin = selectAnchors([day(back(1), 30, 4), day(back(2), 20, 3)], ASOF, W3);
    expect(thin.skip?.code).toBe('none_complete');
    expect(thin.skip?.reason).toContain('none reached 12h');
  });
});

describe('selectAnchors — hostile rows', () => {
  it('drops future-dated and non-finite rows, and counts them', () => {
    const rows = [
      day(addLocalDays(ASOF, 2) as string, 500),
      day(back(1), Number.NaN),
      day(back(2), 20),
      day(back(3), 30),
    ];
    const sel = selectAnchors(rows, ASOF, W3);

    expect(sel.provenance.droppedRows).toBe(2);
    // The dropped back(1) leaves a hole that is reported, not back-filled.
    expect(sel.rolling?.value).toBeCloseTo(25, 10);
    expect(sel.rolling?.daysUsed).toBe(2);
    expect(sel.rolling?.gapDays).toBe(1);
    expect(sel.anchor?.pm25_avg).toBe(20);
  });

  it('is order-insensitive: newest-first and oldest-first agree', () => {
    // Production reads `daily_aq` newest-first; the calibration archive is
    // oldest-first. The answer must not depend on which.
    const rows = [day(ASOF, 99, 19), day(back(1), 30), day(back(2), 20), day(back(3), 10)];
    const newestFirst = selectAnchors(rows, ASOF, W3);
    const oldestFirst = selectAnchors([...rows].reverse(), ASOF, W3);

    expect(oldestFirst.rolling).toEqual(newestFirst.rolling);
    expect(oldestFirst.anchor).toEqual(newestFirst.anchor);
    expect(oldestFirst.provenance).toEqual(newestFirst.provenance);
  });
});

describe('selectAnchors — the naive anchor keeps its thin fallback', () => {
  it('falls back to a thin past day and labels it', () => {
    const sel = selectAnchors([day(ASOF, 99, 19), day(back(1), 30, 5)], ASOF, W1);

    expect(sel.anchor?.local_date).toBe(back(1));
    expect(sel.anchor?.thin).toBe(true);
    expect(sel.anchor?.ageDays).toBe(1);
    // The rolling lag does NOT accept the thin day — the two have different bars
    // on purpose, and persistence degrading is not licence for the fit's input
    // to degrade with it.
    expect(sel.rolling).toBeNull();
    expect(sel.skip?.code).toBe('none_complete');
  });

  it('prefers a complete older day over a thin newer one, and is not thin', () => {
    const sel = selectAnchors([day(back(1), 99, 5), day(back(2), 30)], ASOF, W3);
    expect(sel.anchor?.local_date).toBe(back(2));
    expect(sel.anchor?.thin).toBe(false);
    expect(sel.anchor?.ageDays).toBe(2);
  });
});

describe('selectAnchors — exponential weighting', () => {
  it('weights by calendar offset so a gap does not promote older days', () => {
    // alpha=0.5 over [asOf-3, asOf-1]: weights 0.5, 0.25, 0.125 by offset.
    const rows = [day(back(1), 40), day(back(2), 20), day(back(3), 10)];
    const sel = selectAnchors(rows, ASOF, lagSpec(3, MIN_HOURS_FOR_SCORING, 0.5));
    const expected = (0.5 * 40 + 0.25 * 20 + 0.125 * 10) / (0.5 + 0.25 + 0.125);
    expect(sel.rolling?.value).toBeCloseTo(expected, 10);
  });

  it('renormalises around a gap rather than shifting weights forward', () => {
    // back(2) missing. back(3) must keep its 0.125 weight, not inherit 0.25.
    const rows = [day(back(1), 40), day(back(3), 10)];
    const sel = selectAnchors(rows, ASOF, { ...lagSpec(3, MIN_HOURS_FOR_SCORING, 0.5), minDays: 2 });
    const expected = (0.5 * 40 + 0.125 * 10) / (0.5 + 0.125);
    expect(sel.rolling?.value).toBeCloseTo(expected, 10);
    expect(sel.rolling?.gapDays).toBe(1);
  });
});

describe('resolveLagSpec — v1 coefficients are refused, not guessed at', () => {
  // Deliberately different from the shipped window so the test can tell a
  // row-derived W apart from the constant. If these ever coincide this
  // assertion fails loudly rather than the test quietly proving nothing.
  const FIXTURE_W = 3;

  it('uses a window that is not the rolling_mean constant', () => {
    expect(FIXTURE_W).not.toBe(ROLLING_MEAN_WINDOW_DAYS);
  });

  it('rejects a v1-shaped stats blob that has pm25_lag but no lag_window_days', () => {
    const v1Stats = { r2: 0.42, n: 700, rmse: 8.1, specification: 'lagged_pm25 + same_day_wind' };
    const out = resolveLagSpec({ pm25_lag: 0.5, wind_speed_avg_ms: -6.8 }, v1Stats, MIN_HOURS_FOR_SCORING);

    expect('reason' in out).toBe(true);
    if ('reason' in out) expect(out.reason).toContain('lag_window_days');
  });

  it('returns W from the coefficient row, not from the constant', () => {
    const v2Stats = {
      r2: 0.49,
      n: 700,
      rmse: 8.1,
      specification: 'rolling_pm25_lag + same_day_wind',
      lag_window_days: FIXTURE_W,
      lag_min_hours: MIN_HOURS_FOR_SCORING,
      lag_min_days: 2,
    };
    const out = resolveLagSpec({ pm25_lag: 0.42, wind_speed_avg_ms: -9.07 }, v2Stats, MIN_HOURS_FOR_SCORING);

    expect('spec' in out).toBe(true);
    if ('spec' in out) {
      expect(out.spec?.windowDays).toBe(FIXTURE_W);
      expect(out.spec?.windowDays).not.toBe(ROLLING_MEAN_WINDOW_DAYS);
      expect(out.spec?.minHours).toBe(MIN_HOURS_FOR_SCORING);
      expect(out.spec?.minDays).toBe(2);
    }
  });

  it('allows coefficients that do not use pm25_lag at all', () => {
    // The older temp+wind specification needs no window and must not be blocked.
    const out = resolveLagSpec({ temp_avg_c: -0.34, wind_speed_avg_ms: -4.2 }, { r2: 0.2, n: 700, rmse: 9 }, 12);
    expect(out).toEqual({ spec: null });
  });

  it('refuses a nonsense window rather than coercing it', () => {
    for (const bad of [0, -3, 2.5, 'seven']) {
      const out = resolveLagSpec(
        { pm25_lag: 0.4, wind_speed_avg_ms: -9 },
        { r2: 0.4, n: 1, rmse: 1, lag_window_days: bad as never },
        12,
      );
      expect('reason' in out).toBe(true);
    }
  });
});

describe('the shared-definition claim, as an assertion', () => {
  it('calibration’s asOf = target − h equals production’s asOf = today', () => {
    // scripts/calibrate/fit-wind-model.ts builds its lag at `asOf = target - h`;
    // scripts/predict.ts builds its lag at `asOf = today` and predicts
    // `today + h`. Those are the same call with the same arguments, which is
    // the entire claim of this branch. Asserting it beats commenting it.
    const rows = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => day(back(n), 10 + n));

    for (const horizon of [1, 2, 3] as const) {
      const target = addLocalDays(ASOF, horizon) as string;

      // Production: standing on ASOF, predicting ASOF + h.
      const production = selectAnchors(rows, ASOF, W7);
      // Calibration: standing on target - h, which IS ASOF.
      const calibration = selectAnchors(rows, addLocalDays(target, -horizon) as string, W7);

      expect(calibration.rolling).toEqual(production.rolling);
      expect(calibration.anchor).toEqual(production.anchor);
    }
  });
});
