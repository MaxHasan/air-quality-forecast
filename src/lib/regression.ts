/**
 * regression.ts — closed-form OLS for the two-predictor wind model.
 *
 * The model this whole app is built around:
 *
 *     PM2.5(t+1) = b0 + b_wind · windSpeedAvg(t) + b_temp · tempAvg(t)
 *
 * From the author's 2024 analysis of two years of Nafas PM2.5 × BMKG weather:
 * average wind speed is the dominant predictor (≈ −4.2 µg/m³ per +1 m/s), and
 * rainfall — the intuitive candidate — is not significant.
 *
 * Why hand-rolled rather than a stats package: two predictors have a closed-form
 * solution that is a dozen lines of arithmetic, exactly testable, dependency-free,
 * and runs identically in a GitHub Action and in the browser. Pulling in a matrix
 * library to solve a 2×2 system would be the more complicated choice, not the
 * simpler one.
 *
 * Everything here is pure: no I/O, no clock, no globals.
 */

/** One training row. `x1`/`x2` are day *t*; `y` is the PM2.5 of day *t+1*. */
export interface OlsSample {
  x1: number;
  x2: number;
  y: number;
}

/** Per-predictor inference output. */
export interface OlsTerm {
  /** Point estimate of the slope. */
  estimate: number;
  /** Standard error. `null` when residual df <= 0 (a perfectly saturated fit). */
  stdError: number | null;
  /** estimate / stdError. */
  tStat: number | null;
  /**
   * Two-sided p-value via the **normal** approximation to Student's t.
   * Honest at the n we fit on (hundreds of days); do not trust it below n ≈ 30.
   */
  pValue: number | null;
}

export interface OlsFit {
  intercept: number;
  /** Slope on `x1` — wind speed, m/s. Expected negative. */
  b1: number;
  /** Slope on `x2` — temperature, °C. */
  b2: number;
  /** Rows used. */
  n: number;
  /** Coefficient of determination, 0..1. */
  r2: number;
  /** Adjusted for 2 predictors — the one to quote when comparing specifications. */
  adjR2: number;
  /** Root mean squared *residual*, µg/m³. Uses the n−3 denominator. */
  rmse: number;
  /** Inference for each term. */
  terms: { intercept: OlsTerm; b1: OlsTerm; b2: OlsTerm };
}

/** The three numbers `predict` needs — the shape stored in `model_coefficients`. */
export interface OlsCoefficients {
  intercept: number;
  b1: number;
  b2: number;
}

/**
 * Abramowitz & Stegun 7.1.26 error-function approximation (|ε| < 1.5e-7).
 * Used only for the p-value convenience above.
 */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

/** Two-sided tail probability of the standard normal. */
function twoSidedNormalP(z: number): number {
  return 1 - erf(Math.abs(z) / Math.SQRT2);
}

/**
 * Fit `y ~ b0 + b1·x1 + b2·x2` by ordinary least squares.
 *
 * Returns `null` — never `NaN`-laced garbage — when the fit is not identified:
 *  - fewer than 4 usable rows (3 parameters need residual df >= 1);
 *  - any non-finite value in a row (callers should drop nulls first, but a
 *    stray `NaN` from a bad parse must not silently produce a "model");
 *  - a singular normal-equation system, i.e. a predictor is constant or the two
 *    predictors are perfectly collinear.
 *
 * A `null` here is a legitimate outcome for a region that has not accumulated
 * enough history yet — the caller should surface "calibrating", not an error.
 */
export function olsFit2(samples: readonly OlsSample[]): OlsFit | null {
  const rows = samples.filter(
    (s) => Number.isFinite(s.x1) && Number.isFinite(s.x2) && Number.isFinite(s.y),
  );
  const n = rows.length;
  if (n < 4) return null;

  let sx1 = 0;
  let sx2 = 0;
  let sy = 0;
  for (const r of rows) {
    sx1 += r.x1;
    sx2 += r.x2;
    sy += r.y;
  }
  const mx1 = sx1 / n;
  const mx2 = sx2 / n;
  const my = sy / n;

  // Centered cross-products. Centering keeps the 2×2 system well-conditioned
  // for values like temperature that sit far from zero (≈28 °C here).
  let s11 = 0;
  let s22 = 0;
  let s12 = 0;
  let s1y = 0;
  let s2y = 0;
  let syy = 0;
  for (const r of rows) {
    const d1 = r.x1 - mx1;
    const d2 = r.x2 - mx2;
    const dy = r.y - my;
    s11 += d1 * d1;
    s22 += d2 * d2;
    s12 += d1 * d2;
    s1y += d1 * dy;
    s2y += d2 * dy;
    syy += dy * dy;
  }

  const det = s11 * s22 - s12 * s12;
  // Relative tolerance: an absolute epsilon would misjudge scale-dependent data.
  if (!Number.isFinite(det) || Math.abs(det) <= 1e-12 * Math.max(1, s11 * s22)) return null;

  const b1 = (s22 * s1y - s12 * s2y) / det;
  const b2 = (s11 * s2y - s12 * s1y) / det;
  const intercept = my - b1 * mx1 - b2 * mx2;
  if (!Number.isFinite(b1) || !Number.isFinite(b2) || !Number.isFinite(intercept)) return null;

  // Residual sum of squares, computed directly rather than via the algebraic
  // shortcut so that floating-point error cannot make it negative.
  let ssRes = 0;
  for (const r of rows) {
    const resid = r.y - (intercept + b1 * r.x1 + b2 * r.x2);
    ssRes += resid * resid;
  }
  const ssTot = syy;

  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;
  const df = n - 3;
  const adjR2 = df > 0 && ssTot > 0 ? 1 - (1 - r2) * ((n - 1) / df) : r2;
  const sigma2 = df > 0 ? ssRes / df : null;
  const rmse = df > 0 ? Math.sqrt(ssRes / df) : Math.sqrt(ssRes / n);

  // Standard errors from the inverse of the centered 2×2 system, plus the
  // usual intercept variance term propagated through the means.
  const mkTerm = (estimate: number, variance: number | null): OlsTerm => {
    if (variance === null || !Number.isFinite(variance) || variance < 0) {
      return { estimate, stdError: null, tStat: null, pValue: null };
    }
    const se = Math.sqrt(variance);
    if (se === 0) return { estimate, stdError: 0, tStat: null, pValue: null };
    const t = estimate / se;
    return { estimate, stdError: se, tStat: t, pValue: twoSidedNormalP(t) };
  };

  const var1 = sigma2 === null ? null : (sigma2 * s22) / det;
  const var2 = sigma2 === null ? null : (sigma2 * s11) / det;
  const cov12 = sigma2 === null ? null : (-sigma2 * s12) / det;
  const varIntercept =
    sigma2 === null || var1 === null || var2 === null || cov12 === null
      ? null
      : sigma2 / n + mx1 * mx1 * var1 + mx2 * mx2 * var2 + 2 * mx1 * mx2 * cov12;

  return {
    intercept,
    b1,
    b2,
    n,
    r2,
    adjR2,
    rmse,
    terms: {
      intercept: mkTerm(intercept, varIntercept),
      b1: mkTerm(b1, var1),
      b2: mkTerm(b2, var2),
    },
  };
}

/**
 * Apply fitted coefficients.
 *
 * Deliberately does **not** clamp negatives — `predict.ts` clamps at 0 and
 * records `inputs.clamped`, so that a model drifting into physically impossible
 * territory stays visible in the data rather than being silently tidied away here.
 */
export function olsPredict(coeffs: OlsCoefficients, x1: number, x2: number): number | null {
  if (!Number.isFinite(x1) || !Number.isFinite(x2)) return null;
  const y = coeffs.intercept + coeffs.b1 * x1 + coeffs.b2 * x2;
  return Number.isFinite(y) ? y : null;
}

/** Mean absolute error — the metric the `/models` page ranks on. */
export function meanAbsoluteError(pairs: readonly { predicted: number; actual: number }[]): number | null {
  const usable = pairs.filter((p) => Number.isFinite(p.predicted) && Number.isFinite(p.actual));
  if (usable.length === 0) return null;
  return usable.reduce((acc, p) => acc + Math.abs(p.predicted - p.actual), 0) / usable.length;
}
