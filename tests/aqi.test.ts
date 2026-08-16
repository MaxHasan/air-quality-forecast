import { describe, expect, it } from 'vitest';
import {
  AQI_CATEGORIES,
  EPA_PM25_BREAKPOINTS_2024,
  EPA_PM25_BREAKPOINTS_PRE_2024,
  aqiCategory,
  aqiToPm25,
  pm25Category,
  pm25ToAqi,
  truncateToTenth,
} from '@/lib/aqi';

/**
 * These tests exist because a silent unit error here would corrupt everything
 * downstream: WAQI publishes an AQI sub-index, the models are fit on µg/m³, and
 * nothing in between would complain about the mix-up.
 */

describe('truncateToTenth', () => {
  it('truncates rather than rounds, per EPA convention', () => {
    expect(truncateToTenth(12.19)).toBe(12.1);
    expect(truncateToTenth(12.99)).toBe(12.9);
    expect(truncateToTenth(35.45)).toBe(35.4);
  });

  it('survives binary-float representation of exact tenths', () => {
    // 12.1 * 10 is 120.99999999999999 in IEEE-754; a naive floor drops a band.
    expect(truncateToTenth(12.1)).toBe(12.1);
    expect(truncateToTenth(55.5)).toBe(55.5);
    expect(truncateToTenth(9.1)).toBe(9.1);
  });

  it('handles zero and integers', () => {
    expect(truncateToTenth(0)).toBe(0);
    expect(truncateToTenth(35)).toBe(35);
  });
});

describe('pm25ToAqi — pre-2024 table', () => {
  const t = EPA_PM25_BREAKPOINTS_PRE_2024;

  it('maps the canonical breakpoint boundaries exactly', () => {
    expect(pm25ToAqi(0, t)).toBe(0);
    expect(pm25ToAqi(12.0, t)).toBe(50);
    expect(pm25ToAqi(12.1, t)).toBe(51);
    expect(pm25ToAqi(35.4, t)).toBe(100);
    expect(pm25ToAqi(35.5, t)).toBe(101);
    expect(pm25ToAqi(55.4, t)).toBe(150);
    expect(pm25ToAqi(55.5, t)).toBe(151);
    expect(pm25ToAqi(150.4, t)).toBe(200);
    expect(pm25ToAqi(250.4, t)).toBe(300);
    expect(pm25ToAqi(350.4, t)).toBe(400);
    expect(pm25ToAqi(500.4, t)).toBe(500);
  });

  it('reproduces the EPA worked example (35.9 µg/m³ -> AQI 102)', () => {
    expect(pm25ToAqi(35.9, t)).toBe(102);
  });
});

describe('pm25ToAqi — 2024 revision', () => {
  const t = EPA_PM25_BREAKPOINTS_2024;

  it('maps the revised boundaries exactly', () => {
    expect(pm25ToAqi(9.0, t)).toBe(50);
    expect(pm25ToAqi(9.1, t)).toBe(51);
    expect(pm25ToAqi(35.4, t)).toBe(100);
    expect(pm25ToAqi(55.4, t)).toBe(150);
    expect(pm25ToAqi(125.4, t)).toBe(200);
    expect(pm25ToAqi(225.4, t)).toBe(300);
    expect(pm25ToAqi(325.4, t)).toBe(500);
  });

  it('differs from the pre-2024 table where Jakarta actually sits', () => {
    // The whole reason both tables are shipped: at 10 µg/m³ the two disagree
    // about whether the air is "Good", and at 60 they disagree by ~7 AQI points.
    expect(pm25ToAqi(10, EPA_PM25_BREAKPOINTS_PRE_2024)).toBeLessThanOrEqual(50);
    expect(pm25ToAqi(10, EPA_PM25_BREAKPOINTS_2024)).toBeGreaterThan(50);
    expect(pm25ToAqi(60, EPA_PM25_BREAKPOINTS_2024)).not.toBe(
      pm25ToAqi(60, EPA_PM25_BREAKPOINTS_PRE_2024),
    );
  });
});

describe('aqiToPm25 — the inversion the WAQI connector depends on', () => {
  for (const table of [EPA_PM25_BREAKPOINTS_PRE_2024, EPA_PM25_BREAKPOINTS_2024]) {
    describe(table.id, () => {
      it('returns each band floor at its index floor', () => {
        for (const bp of table.breakpoints) {
          expect(aqiToPm25(bp.iLow, table)).toBeCloseTo(bp.cLow, 5);
        }
      });

      it('returns each band ceiling at its index ceiling', () => {
        for (const bp of table.breakpoints) {
          expect(aqiToPm25(bp.iHigh, table)).toBeCloseTo(bp.cHigh, 5);
        }
      });

      it('round-trips concentration -> AQI -> concentration within quantisation error', () => {
        // WAQI publishes integer AQI, so the inverse can only be as precise as
        // one index step. At the low end that is ~0.5 µg/m³; higher up, ~2.
        for (const pm of [5, 12, 20, 35, 50, 75, 120, 200]) {
          const aqi = pm25ToAqi(pm, table);
          expect(aqi).not.toBeNull();
          const back = aqiToPm25(aqi as number, table);
          expect(back).not.toBeNull();
          expect(Math.abs((back as number) - pm)).toBeLessThanOrEqual(2.1);
        }
      });

      it('is monotonically non-decreasing across the whole index range', () => {
        let prev = -Infinity;
        for (let i = 0; i <= 500; i += 1) {
          const c = aqiToPm25(i, table);
          if (c === null) continue;
          expect(c).toBeGreaterThanOrEqual(prev);
          prev = c;
        }
      });
    });
  }

  it('inverts a realistic WAQI reading to a plausible concentration', () => {
    // An `iaqi.pm25.v` of 155 is AQI 155, i.e. ~63 µg/m³ — NOT 155 µg/m³.
    // Interpolating in the 151-200 band (55.5-150.4 µg/m³):
    //   55.5 + (150.4 - 55.5) / (200 - 151) * (155 - 151) = 63.2
    // Taking the index at face value would overstate the concentration by 2.5x
    // and turn an "Unhealthy for Sensitive Groups" day into a false emergency.
    expect(aqiToPm25(155, EPA_PM25_BREAKPOINTS_PRE_2024)).toBeCloseTo(63.2, 1);
  });
});

describe('invalid input', () => {
  it('returns null rather than clamping or NaN', () => {
    expect(pm25ToAqi(Number.NaN)).toBeNull();
    expect(pm25ToAqi(-1)).toBeNull();
    expect(pm25ToAqi(10_000)).toBeNull();
    expect(aqiToPm25(Number.NaN)).toBeNull();
    expect(aqiToPm25(-5)).toBeNull();
    expect(aqiToPm25(9_999)).toBeNull();
    expect(aqiCategory(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('categories', () => {
  it('covers 0-500 contiguously with no gaps', () => {
    for (let i = 0; i <= 500; i += 1) {
      expect(aqiCategory(i), `AQI ${i} has no category`).not.toBeNull();
    }
  });

  it('names the expected band at the boundaries', () => {
    expect(aqiCategory(50)?.key).toBe('good');
    expect(aqiCategory(51)?.key).toBe('moderate');
    expect(aqiCategory(150)?.key).toBe('unhealthy_sensitive');
    expect(aqiCategory(151)?.key).toBe('unhealthy');
    expect(aqiCategory(300)?.key).toBe('very_unhealthy');
    expect(aqiCategory(301)?.key).toBe('hazardous');
  });

  it('is table-dependent for concentrations, as documented', () => {
    expect(pm25Category(10, EPA_PM25_BREAKPOINTS_PRE_2024)?.key).toBe('good');
    expect(pm25Category(10, EPA_PM25_BREAKPOINTS_2024)?.key).toBe('moderate');
  });

  it('exposes a colour and readable foreground for every category', () => {
    for (const c of AQI_CATEGORIES) {
      expect(c.color).toMatch(/^#[0-9a-f]{6}$/i);
      expect(c.onColor).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});
