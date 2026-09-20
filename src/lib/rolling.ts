/**
 * rolling.ts — ONE definition of "the PM2.5 level we already know".
 *
 * ---------------------------------------------------------------------------
 * Why this file exists
 * ---------------------------------------------------------------------------
 * The wind regression is fitted on one definition of its `pm25_lag` predictor
 * and evaluated at inference on another. That is the bug this module removes,
 * and the reason it is a shared module rather than a helper inside either
 * caller: the mismatch arose precisely because the two sides each had their own
 * copy of "yesterday's mean", and the copies drifted.
 *
 *   calibration  scripts/calibrate/fit-wind-model.ts fitted b_lag on the mean
 *                of a COMPLETE previous calendar day.
 *   inference    scripts/predict.ts ran at 19:37 WIB, after the rollup had
 *                written TODAY's ~19-hour partial mean into `daily_aq`, and
 *                took the newest row with hours_count >= 12 — which is that
 *                partial. A slope fitted on a 24-hour mean was being applied to
 *                a 19-hour one, every night, at every horizon.
 *
 * This project has been here before: fitting on BMKG wind and predicting with
 * Open-Meteo wind cost it R² 0.20 against 0.42. Train on the same source you
 * will predict with. Both callers now import from here, and neither computes a
 * lag of its own.
 *
 * ---------------------------------------------------------------------------
 * What "complete day" means, exactly
 * ---------------------------------------------------------------------------
 * BOTH of:
 *
 *   1. `local_date < asOf` in the location's own timezone. A day that is still
 *      being lived is not an observation of that day, however many hours of it
 *      have landed.
 *   2. `hours_count >= minHours` (MIN_HOURS_FOR_SCORING, 12) — the same bar
 *      `prediction_scores` uses before it will judge a model by a day.
 *
 * Condition 2 alone IS the current bug. `readAnchor` applied it and nothing
 * else, so today's row cleared it from about 12:00 WIB onward and shadowed
 * yesterday's complete one for the rest of the day.
 *
 * ---------------------------------------------------------------------------
 * The window is a calendar span, and never stretches
 * ---------------------------------------------------------------------------
 * The rolling window is `[asOf − windowDays, asOf − 1]` inclusive, and a gap
 * inside it is left as a gap. It is tempting to walk further back until W days
 * have been collected, and it is wrong: a "3-day mean" that quietly becomes
 * "3 of the last 9 days" is a different estimator from the one b_lag was fitted
 * on, and it would be different only on exactly the days when the feed was
 * unhealthy — the days a forecast is least able to afford it.
 *
 * So the degradation is recorded instead of repaired: `daysUsed` and `gapDays`
 * ride along into `predictions.inputs`, and below `minDays` the lag refuses to
 * produce a value at all and says why. Refusing with a reason is this
 * codebase's established habit (predict.ts's skip list, surfaced via run.note)
 * and it is the only version of this that can be audited afterwards.
 *
 * Everything here is pure: no I/O, no clock, no globals — the same contract as
 * src/lib/regression.ts. `asOf` is always passed in.
 */

import { addLocalDays, diffLocalDays } from './format';
import type { Json, LocalDate, ModelCoefficientMap } from './types';

/* -------------------------------------------------------------------------- */
/* The specification                                                          */
/* -------------------------------------------------------------------------- */

/**
 * How to build the lag. Travels with the coefficients that were fitted on it —
 * see `resolveLagSpec`.
 */
export interface LagSpec {
  /** Calendar span of the window, in days back from `asOf`. `1` = the last complete day. */
  windowDays: number;
  /** A day below this many observed hours is not a complete day. */
  minHours: number;
  /** Fewer complete days than this in the span and the lag refuses to emit. */
  minDays: number;
  /**
   * Exponential recency weight, if the fit used one. `undefined` = a flat mean.
   *
   * Weights are assigned by CALENDAR offset from the window's newest day, not
   * by rank among the days that happen to be present, so a gap drops its own
   * weight and the survivors renormalise — it does not promote older days into
   * the weight a missing fresher day would have carried.
   */
  alpha?: number;
}

/** The floor on complete days, as a function of the span. Half the window, at least one. */
export function defaultMinDays(windowDays: number): number {
  return Math.max(1, Math.ceil(windowDays / 2));
}

/** A `LagSpec` from a window length alone, with this project's standard floors. */
export function lagSpec(windowDays: number, minHours: number, alpha?: number): LagSpec {
  return { windowDays, minHours, minDays: defaultMinDays(windowDays), ...(alpha === undefined ? {} : { alpha }) };
}

/* -------------------------------------------------------------------------- */
/* Inputs and outputs                                                         */
/* -------------------------------------------------------------------------- */

/** One observed daily mean. The `daily_aq` columns this module needs, and no others. */
export interface DailyMean {
  local_date: LocalDate;
  pm25_avg: number;
  hours_count: number;
}

/** The naive anchor: a single most-recent day. `persistence`'s answer. */
export interface NaiveAnchor {
  local_date: LocalDate;
  pm25_avg: number;
  hours_count: number;
  /**
   * True when no complete past day existed and this is a past day of any depth.
   * A thin anchor is worse than a stale one, but no anchor at all means no
   * persistence prediction — so the fallback exists, labelled.
   */
  thin: boolean;
  /** Whole days from this day to `asOf`. 1 = yesterday. */
  ageDays: number;
}

/** A computed rolling lag, with enough provenance to audit it a month later. */
export interface RollingLag {
  value: number;
  windowDays: number;
  /** Complete days actually averaged. */
  daysUsed: number;
  /** `windowDays - daysUsed` — days of the span that had no usable observation. */
  gapDays: number;
  windowStart: LocalDate;
  windowEnd: LocalDate;
}

/** Why no rolling lag could be produced. `code` is for tests and dashboards; `reason` for humans. */
export interface RollingSkip {
  code: 'no_rows' | 'none_complete' | 'below_min_days';
  reason: string;
}

/**
 * Whatever was true about the input that a reader of `predictions.inputs` would
 * want six weeks later, including the thing that was deliberately NOT used.
 */
export interface AnchorProvenance {
  /**
   * Today's partial row, when one exists. Recorded precisely because it is
   * excluded: "this run saw a 19-hour mean for today and did not use it" is the
   * fact that distinguishes the fixed behaviour from the old behaviour, and
   * without it the two are indistinguishable in the stored row.
   */
  partialToday: { local_date: LocalDate; pm25_avg: number; hours_count: number } | null;
  /** Rows dropped as future-dated or non-finite. Should be 0; a non-zero value is a rollup bug. */
  droppedRows: number;
}

export interface AnchorSelection {
  anchor: NaiveAnchor | null;
  rolling: RollingLag | null;
  /** Set exactly when `rolling` is null. */
  skip: RollingSkip | null;
  provenance: AnchorProvenance;
}

/* -------------------------------------------------------------------------- */
/* Selection                                                                  */
/* -------------------------------------------------------------------------- */

function isFiniteNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

/**
 * Both anchors from one pass over `daily_aq`.
 *
 * `rows` may arrive in any order — production reads newest-first, the
 * calibration archive is oldest-first, and the answer must not depend on which.
 * Duplicate dates (which the `daily_aq` unique key makes impossible, but a
 * caller could still construct) resolve to the deepest row for that date.
 */
export function selectAnchors(
  rows: readonly DailyMean[],
  asOf: LocalDate,
  spec: LagSpec,
): AnchorSelection {
  /* -- clean and index ---------------------------------------------------- */
  const byDate = new Map<LocalDate, DailyMean>();
  let droppedRows = 0;
  let partialToday: AnchorProvenance['partialToday'] = null;

  for (const row of rows) {
    const age = diffLocalDays(row.local_date, asOf);
    // Unparseable date, non-finite mean, or dated in the future: all three are
    // rollup faults rather than data, and averaging them in would be the kind of
    // quiet corruption this module exists to prevent.
    if (age === null || !isFiniteNumber(row.pm25_avg) || !isFiniteNumber(row.hours_count) || age < 0) {
      droppedRows += 1;
      continue;
    }
    if (age === 0) {
      // Today. Never an input; always reported.
      if (partialToday === null || row.hours_count > partialToday.hours_count) {
        partialToday = { local_date: row.local_date, pm25_avg: row.pm25_avg, hours_count: row.hours_count };
      }
      continue;
    }
    const seen = byDate.get(row.local_date);
    if (!seen || row.hours_count > seen.hours_count) byDate.set(row.local_date, row);
  }

  const past = [...byDate.values()].sort((a, b) => (a.local_date < b.local_date ? 1 : -1)); // newest first
  const provenance: AnchorProvenance = { partialToday, droppedRows };

  /* -- the naive anchor --------------------------------------------------- */
  // Unchanged in spirit from the old readAnchor: prefer a complete day, fall
  // back to a thin one and say so. The ONLY change is that `past` no longer
  // contains today.
  const solid = past.find((r) => r.hours_count >= spec.minHours);
  const chosen = solid ?? past[0];
  const anchor: NaiveAnchor | null = chosen
    ? {
        local_date: chosen.local_date,
        pm25_avg: chosen.pm25_avg,
        hours_count: chosen.hours_count,
        thin: solid === undefined,
        ageDays: diffLocalDays(chosen.local_date, asOf) ?? 0,
      }
    : null;

  /* -- the rolling lag ---------------------------------------------------- */
  const windowStart = addLocalDays(asOf, -spec.windowDays);
  const windowEnd = addLocalDays(asOf, -1);
  if (!windowStart || !windowEnd || spec.windowDays < 1) {
    return {
      anchor,
      rolling: null,
      skip: { code: 'no_rows', reason: `invalid lag window (windowDays=${spec.windowDays}, asOf=${asOf})` },
      provenance,
    };
  }

  // The span, and nothing outside it. Days are collected by calendar offset so
  // that a missing day stays missing rather than pulling an older one forward.
  let weighted = 0;
  let weight = 0;
  let flat = 0;
  let daysUsed = 0;
  let inWindow = 0;

  for (let k = 0; k < spec.windowDays; k += 1) {
    const date = addLocalDays(windowEnd, -k);
    if (!date) continue;
    const row = byDate.get(date);
    if (!row) continue;
    inWindow += 1;
    if (row.hours_count < spec.minHours) continue;
    const w = spec.alpha === undefined ? 1 : spec.alpha * (1 - spec.alpha) ** k;
    weighted += w * row.pm25_avg;
    weight += w;
    flat += row.pm25_avg;
    daysUsed += 1;
  }

  const span = `[${windowStart}..${windowEnd}]`;
  if (daysUsed === 0) {
    const skip: RollingSkip =
      inWindow === 0
        ? { code: 'no_rows', reason: `no daily mean at all in ${span}` }
        : {
            code: 'none_complete',
            reason: `${inWindow} row(s) in ${span} but none reached ${spec.minHours}h`,
          };
    return { anchor, rolling: null, skip, provenance };
  }

  if (daysUsed < spec.minDays) {
    return {
      anchor,
      rolling: null,
      skip: {
        code: 'below_min_days',
        reason: `only ${daysUsed} complete day(s) in ${span}, below the minimum of ${spec.minDays}`,
      },
      provenance,
    };
  }

  const value = spec.alpha === undefined ? flat / daysUsed : weighted / weight;
  return {
    anchor,
    rolling: {
      value,
      windowDays: spec.windowDays,
      daysUsed,
      gapDays: spec.windowDays - daysUsed,
      windowStart,
      windowEnd,
    },
    skip: null,
    provenance,
  };
}

/* -------------------------------------------------------------------------- */
/* Reading the specification off a coefficient row                            */
/* -------------------------------------------------------------------------- */

/**
 * The v1 rejection. This is the structural guarantee that the mismatch cannot
 * come back.
 *
 * `pm25_lag` is a slope on "the level you already know", and the number that
 * slope is correct for depends entirely on how that level was computed. v1's
 * `stats` does not say, because v1 had only one answer and it was wrong. So:
 * coefficients that ask for `pm25_lag` without declaring `lag_window_days` are
 * REFUSED rather than guessed at, exactly as `applyCoefficients` refuses a
 * predictor name it cannot supply.
 *
 * This is also what makes the migration ordering safe. Ship 0009 late and the
 * new code sees v1 stats, skips `wind_regression` with a recorded reason, and
 * the other three models carry the night. Guess a window instead and the
 * failure would be invisible.
 *
 * Coefficients with no `pm25_lag` at all (the old temp+wind specification) need
 * no window and are allowed through with `spec: null`.
 */
export function resolveLagSpec(
  coef: ModelCoefficientMap | null | undefined,
  stats: Record<string, Json | undefined> | null | undefined,
  fallbackMinHours: number,
): { spec: LagSpec | null } | { reason: string } {
  const usesLag = coef !== null && coef !== undefined && isFiniteNumber(coef.pm25_lag);
  if (!usesLag) return { spec: null };

  const windowDays = stats?.lag_window_days;
  if (!isFiniteNumber(windowDays) || !Number.isInteger(windowDays) || windowDays < 1) {
    return {
      reason:
        'coefficients use pm25_lag but stats carries no lag_window_days — a v1 (single partial-day) fit. ' +
        'Refusing to feed a rolling lag into a slope that was not fitted on one; apply 0009.',
    };
  }

  const minHours = stats?.lag_min_hours;
  const minDays = stats?.lag_min_days;
  return {
    spec: {
      windowDays,
      minHours: isFiniteNumber(minHours) && minHours > 0 ? minHours : fallbackMinHours,
      minDays: isFiniteNumber(minDays) && minDays > 0 ? minDays : defaultMinDays(windowDays),
      ...(isFiniteNumber(stats?.lag_alpha) ? { alpha: stats.lag_alpha } : {}),
    },
  };
}
