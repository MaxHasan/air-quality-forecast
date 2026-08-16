import { describe, expect, it } from 'vitest';
import { meanAbsoluteError, olsFit2, olsPredict, type OlsSample } from '@/lib/regression';

/**
 * The published fixture.
 *
 * The author's 2024 analysis reported two figures that pin the model down:
 *   - a wind slope of about −4.2 µg/m³ per +1 m/s;
 *   - a worked example where a day at 25 °C with 2 m/s of wind predicts
 *     28.13 µg/m³ for the following day.
 *
 * The intercept quoted alongside the single-predictor form was ≈45. Holding the
 * intercept and wind slope fixed, the temperature slope the example implies is:
 *
 *     28.13 = 45 + (−4.2 × 2) + b_temp × 25
 *     28.13 = 36.6 + 25·b_temp
 *     b_temp = (28.13 − 36.6) / 25 = −0.3388
 *
 * That back-solved value is used here purely to verify `olsPredict` does the
 * arithmetic correctly. It is NOT the coefficient the app ships: the real ones
 * come from refitting the 2022–2023 Nafas × BMKG data in
 * `scripts/calibrate/fit-jakarta.ts`, which is gated on the wind slope landing
 * within −4.2 ± 2 and negative.
 */
const PUBLISHED_FIXTURE = { intercept: 45, b1: -4.2, b2: -0.3388 } as const;

describe('olsPredict', () => {
  it('reproduces the published worked example (25 °C, 2 m/s -> ~28.13 µg/m³)', () => {
    const y = olsPredict(PUBLISHED_FIXTURE, 2, 25);
    expect(y).not.toBeNull();
    expect(y as number).toBeCloseTo(28.13, 2);
  });

  it('moves PM2.5 down by ~4.2 for every extra m/s of wind', () => {
    const calm = olsPredict(PUBLISHED_FIXTURE, 2, 25) as number;
    const breezy = olsPredict(PUBLISHED_FIXTURE, 3, 25) as number;
    expect(calm - breezy).toBeCloseTo(4.2, 6);
  });

  it('returns null on non-finite inputs instead of propagating NaN', () => {
    expect(olsPredict(PUBLISHED_FIXTURE, Number.NaN, 25)).toBeNull();
    expect(olsPredict(PUBLISHED_FIXTURE, 2, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('does not clamp negative output — clamping is predict.ts’s job, and it records the fact', () => {
    const y = olsPredict(PUBLISHED_FIXTURE, 30, 25);
    expect(y as number).toBeLessThan(0);
  });
});

describe('olsFit2 — recovery of known coefficients', () => {
  /** Deterministic LCG: reproducible "noise" without a seeded-RNG dependency. */
  function makeRng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0x1_0000_0000;
    };
  }

  function synthetic(n: number, truth: { intercept: number; b1: number; b2: number }, noise: number): OlsSample[] {
    const rng = makeRng(42);
    const rows: OlsSample[] = [];
    for (let i = 0; i < n; i += 1) {
      // Ranges chosen to look like the real thing: wind 0.5-6 m/s, temp 24-32 °C.
      const x1 = 0.5 + rng() * 5.5;
      const x2 = 24 + rng() * 8;
      const eps = (rng() - 0.5) * 2 * noise;
      rows.push({ x1, x2, y: truth.intercept + truth.b1 * x1 + truth.b2 * x2 + eps });
    }
    return rows;
  }

  it('recovers coefficients exactly from noiseless data', () => {
    const truth = { intercept: 45, b1: -4.2, b2: -0.34 };
    const fit = olsFit2(synthetic(200, truth, 0));
    expect(fit).not.toBeNull();
    expect(fit!.intercept).toBeCloseTo(truth.intercept, 6);
    expect(fit!.b1).toBeCloseTo(truth.b1, 6);
    expect(fit!.b2).toBeCloseTo(truth.b2, 6);
    expect(fit!.r2).toBeCloseTo(1, 6);
    expect(fit!.rmse).toBeCloseTo(0, 6);
  });

  it('recovers them approximately under realistic noise', () => {
    const truth = { intercept: 45, b1: -4.2, b2: -0.34 };
    // ±12 µg/m³ of day-to-day scatter — comparable to the real residual spread.
    const fit = olsFit2(synthetic(700, truth, 12));
    expect(fit).not.toBeNull();
    expect(fit!.b1).toBeCloseTo(truth.b1, 0);
    expect(fit!.n).toBe(700);
    expect(fit!.r2).toBeGreaterThan(0);
    expect(fit!.r2).toBeLessThan(1);
    // Adjusted R² penalises the extra parameters, so it can only be lower.
    expect(fit!.adjR2).toBeLessThanOrEqual(fit!.r2);
  });

  it('reports a significant, negative wind slope on strongly-signalled data', () => {
    const fit = olsFit2(synthetic(700, { intercept: 45, b1: -4.2, b2: -0.34 }, 8));
    expect(fit).not.toBeNull();
    expect(fit!.terms.b1.estimate).toBeLessThan(0);
    expect(fit!.terms.b1.tStat).not.toBeNull();
    expect(Math.abs(fit!.terms.b1.tStat as number)).toBeGreaterThan(2);
    expect(fit!.terms.b1.pValue as number).toBeLessThan(0.05);
  });

  it('ignores rows containing non-finite values rather than poisoning the fit', () => {
    const clean = synthetic(100, { intercept: 45, b1: -4.2, b2: -0.34 }, 0);
    const dirty: OlsSample[] = [...clean, { x1: Number.NaN, x2: 25, y: 30 }, { x1: 2, x2: 25, y: Number.NaN }];
    const fit = olsFit2(dirty);
    expect(fit).not.toBeNull();
    expect(fit!.n).toBe(100);
    expect(fit!.b1).toBeCloseTo(-4.2, 6);
  });
});

describe('olsFit2 — unidentified fits return null, never NaN', () => {
  it('rejects too-few rows', () => {
    expect(olsFit2([])).toBeNull();
    expect(
      olsFit2([
        { x1: 1, x2: 20, y: 30 },
        { x1: 2, x2: 21, y: 28 },
        { x1: 3, x2: 22, y: 26 },
      ]),
    ).toBeNull();
  });

  it('rejects a constant predictor', () => {
    const rows: OlsSample[] = Array.from({ length: 50 }, (_, i) => ({ x1: 2, x2: 24 + i * 0.1, y: 30 + i }));
    expect(olsFit2(rows)).toBeNull();
  });

  it('rejects perfectly collinear predictors', () => {
    const rows: OlsSample[] = Array.from({ length: 50 }, (_, i) => {
      const x1 = 1 + i * 0.1;
      return { x1, x2: 3 * x1 + 5, y: 40 - 2 * x1 };
    });
    expect(olsFit2(rows)).toBeNull();
  });
});

describe('meanAbsoluteError', () => {
  it('averages absolute deviations', () => {
    expect(
      meanAbsoluteError([
        { predicted: 30, actual: 25 },
        { predicted: 20, actual: 25 },
      ]),
    ).toBeCloseTo(5, 6);
  });

  it('returns null when nothing is scorable', () => {
    expect(meanAbsoluteError([])).toBeNull();
    expect(meanAbsoluteError([{ predicted: Number.NaN, actual: 25 }])).toBeNull();
  });
});
