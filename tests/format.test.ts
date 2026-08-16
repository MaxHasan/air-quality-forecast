import { describe, expect, it } from 'vitest';
import {
  addLocalDays,
  circularMeanDegrees,
  compassPoint,
  diffLocalDays,
  localDateRange,
  localDateStartUtc,
  localDayUtcRange,
  toLocalDate,
  toLocalHour,
  toLocalHourLabel,
  todayLocalDate,
  tomorrowLocalDate,
} from '@/lib/format';

/**
 * All three covered zones are ahead of UTC, so the late-UTC hours of a day
 * already belong to the next local day. Bucketing on the UTC date would move
 * ~7 hours of every Jakarta day into the wrong average — the single most
 * damaging silent bug available in this codebase.
 */

describe('toLocalDate', () => {
  it('rolls Jakarta forward past 17:00 UTC (UTC+7)', () => {
    expect(toLocalDate('2026-08-16T16:59:59Z', 'Asia/Jakarta')).toBe('2026-08-16');
    expect(toLocalDate('2026-08-16T17:00:00Z', 'Asia/Jakarta')).toBe('2026-08-17');
  });

  it('rolls Bali and Singapore forward past 16:00 UTC (UTC+8)', () => {
    expect(toLocalDate('2026-08-16T15:59:59Z', 'Asia/Makassar')).toBe('2026-08-16');
    expect(toLocalDate('2026-08-16T16:00:00Z', 'Asia/Makassar')).toBe('2026-08-17');
    expect(toLocalDate('2026-08-16T16:00:00Z', 'Asia/Singapore')).toBe('2026-08-17');
  });

  it('puts Bali a day ahead of Jakarta in the 16:00-17:00 UTC window', () => {
    // The reason Bali must be Asia/Makassar and not Asia/Jakarta.
    const instant = '2026-08-16T16:30:00Z';
    expect(toLocalDate(instant, 'Asia/Jakarta')).toBe('2026-08-16');
    expect(toLocalDate(instant, 'Asia/Makassar')).toBe('2026-08-17');
  });

  it('handles year, month and leap-day boundaries', () => {
    expect(toLocalDate('2025-12-31T17:00:00Z', 'Asia/Jakarta')).toBe('2026-01-01');
    expect(toLocalDate('2024-02-28T17:00:00Z', 'Asia/Jakarta')).toBe('2024-02-29');
    expect(toLocalDate('2024-02-29T16:00:00Z', 'Asia/Singapore')).toBe('2024-03-01');
  });

  it('accepts Date and epoch-millisecond inputs', () => {
    const d = new Date('2026-08-16T17:00:00Z');
    expect(toLocalDate(d, 'Asia/Jakarta')).toBe('2026-08-17');
    expect(toLocalDate(d.getTime(), 'Asia/Jakarta')).toBe('2026-08-17');
  });

  it('returns null on unparseable input', () => {
    expect(toLocalDate('not-a-date', 'Asia/Jakarta')).toBeNull();
  });
});

describe('toLocalHour / toLocalHourLabel', () => {
  it('shifts by the zone offset', () => {
    expect(toLocalHour('2026-08-16T00:00:00Z', 'Asia/Jakarta')).toBe(7);
    expect(toLocalHour('2026-08-16T00:00:00Z', 'Asia/Singapore')).toBe(8);
  });

  it('wraps to hour 0 at local midnight, not 24', () => {
    expect(toLocalHour('2026-08-16T17:00:00Z', 'Asia/Jakarta')).toBe(0);
    expect(toLocalHourLabel('2026-08-16T17:00:00Z', 'Asia/Jakarta')).toBe('00:00');
  });

  it('zero-pads the label', () => {
    expect(toLocalHourLabel('2026-08-16T01:00:00Z', 'Asia/Jakarta')).toBe('08:00');
  });
});

describe('localDateStartUtc / localDayUtcRange', () => {
  it('finds the UTC instant of local midnight', () => {
    expect(localDateStartUtc('2026-08-17', 'Asia/Jakarta')?.toISOString()).toBe('2026-08-16T17:00:00.000Z');
    expect(localDateStartUtc('2026-08-17', 'Asia/Makassar')?.toISOString()).toBe('2026-08-16T16:00:00.000Z');
    expect(localDateStartUtc('2026-08-17', 'Asia/Singapore')?.toISOString()).toBe('2026-08-16T16:00:00.000Z');
  });

  it('produces a half-open 24-hour window', () => {
    const r = localDayUtcRange('2026-08-17', 'Asia/Jakarta');
    expect(r).not.toBeNull();
    expect(r!.startIso).toBe('2026-08-16T17:00:00.000Z');
    expect(r!.endIso).toBe('2026-08-17T17:00:00.000Z');
    expect(r!.end.getTime() - r!.start.getTime()).toBe(24 * 3_600_000);
  });

  it('round-trips: every hour in the window maps back to the same local date', () => {
    const date = '2026-08-17';
    const r = localDayUtcRange(date, 'Asia/Jakarta')!;
    for (let t = r.start.getTime(); t < r.end.getTime(); t += 3_600_000) {
      expect(toLocalDate(t, 'Asia/Jakarta')).toBe(date);
    }
    // And the instant immediately before the window belongs to the previous day.
    expect(toLocalDate(r.start.getTime() - 1, 'Asia/Jakarta')).toBe('2026-08-16');
    expect(toLocalDate(r.end.getTime(), 'Asia/Jakarta')).toBe('2026-08-18');
  });

  it('rejects malformed and impossible dates', () => {
    expect(localDateStartUtc('2026-8-17', 'Asia/Jakarta')).toBeNull();
    expect(localDateStartUtc('2026-02-30', 'Asia/Jakarta')).toBeNull();
    expect(localDateStartUtc('2026-13-01', 'Asia/Jakarta')).toBeNull();
  });
});

describe('local date arithmetic', () => {
  it('adds and subtracts days across month and year ends', () => {
    expect(addLocalDays('2026-08-31', 1)).toBe('2026-09-01');
    expect(addLocalDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addLocalDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addLocalDays('2026-08-16', 0)).toBe('2026-08-16');
  });

  it('differences dates', () => {
    expect(diffLocalDays('2026-08-16', '2026-08-19')).toBe(3);
    expect(diffLocalDays('2026-08-19', '2026-08-16')).toBe(-3);
    expect(diffLocalDays('2026-08-16', '2026-08-16')).toBe(0);
  });

  it('builds inclusive ranges, empty when reversed', () => {
    expect(localDateRange('2026-08-16', '2026-08-18')).toEqual(['2026-08-16', '2026-08-17', '2026-08-18']);
    expect(localDateRange('2026-08-18', '2026-08-16')).toEqual([]);
  });

  it('derives today and tomorrow from an injected clock', () => {
    const now = new Date('2026-08-16T17:30:00Z'); // already the 17th in Jakarta
    expect(todayLocalDate('Asia/Jakarta', now)).toBe('2026-08-17');
    expect(tomorrowLocalDate('Asia/Jakarta', now)).toBe('2026-08-18');
  });
});

describe('circularMeanDegrees', () => {
  it('averages across the 0/360 wrap instead of through south', () => {
    // The bug this guards: a scalar mean of 350 and 10 gives 180 — due south,
    // the opposite of the truth, and enough to invert the seasonal wind story.
    const r = circularMeanDegrees([350, 10]);
    expect(r).not.toBeNull();
    expect(r!.mean).toBeCloseTo(0, 6);
    expect(r!.consistency).toBeGreaterThan(0.98);
  });

  it('handles the simple non-wrapping case', () => {
    const r = circularMeanDegrees([80, 100]);
    expect(r!.mean).toBeCloseTo(90, 6);
  });

  it('reports near-zero consistency for opposing directions', () => {
    const r = circularMeanDegrees([0, 180]);
    expect(r!.consistency).toBeLessThan(1e-6);
  });

  it('reports consistency 1 for a steady wind', () => {
    const r = circularMeanDegrees([90, 90, 90]);
    expect(r!.mean).toBeCloseTo(90, 6);
    expect(r!.consistency).toBeCloseTo(1, 6);
  });

  it('skips nulls and returns null when nothing usable remains', () => {
    const r = circularMeanDegrees([null, 90, undefined, Number.NaN]);
    expect(r!.mean).toBeCloseTo(90, 6);
    expect(circularMeanDegrees([null, undefined])).toBeNull();
    expect(circularMeanDegrees([])).toBeNull();
  });

  it('always returns a bearing in [0, 360)', () => {
    for (const dirs of [[200, 250], [300, 20], [181, 179], [359, 1]]) {
      const r = circularMeanDegrees(dirs)!;
      expect(r.mean).toBeGreaterThanOrEqual(0);
      expect(r.mean).toBeLessThan(360);
    }
  });
});

describe('compassPoint', () => {
  it('labels the cardinals and wraps at 360', () => {
    expect(compassPoint(0)).toBe('N');
    expect(compassPoint(90)).toBe('E');
    expect(compassPoint(180)).toBe('S');
    expect(compassPoint(270)).toBe('W');
    expect(compassPoint(360)).toBe('N');
    expect(compassPoint(-90)).toBe('W');
  });

  it('labels the intercardinals used in the seasonal story', () => {
    // Dry-season easterlies vs wet-season north-westerlies.
    expect(compassPoint(112.5)).toBe('ESE');
    expect(compassPoint(315)).toBe('NW');
  });
});
