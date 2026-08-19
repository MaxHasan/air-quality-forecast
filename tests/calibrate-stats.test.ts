/**
 * mergeStats — what a refit is allowed to overwrite, and what it must keep.
 *
 * `model_coefficients.stats` holds two kinds of thing with no marker
 * distinguishing them: measurements this fit produced, and annotations other
 * migrations stamped on afterwards (0006 writes `station_mix_changed_at` to
 * record that a location's ground truth changed instrument mix on a given
 * date). A refit owns the first and must not touch the second.
 *
 * Both mistakes are silent, which is why they get a test rather than a comment:
 *
 *   replace wholesale  -> the annotation disappears. This actually happened:
 *                         applying 0007 dropped the stamp from jakarta-central
 *                         and bsd, because the upsert ended `stats = excluded.stats`.
 *   concatenate naively -> a measured key the fit no longer emits keeps its old
 *                         value and is read as current, so one fit gets
 *                         described by another fit's numbers.
 */

import { describe, expect, it } from 'vitest';
import { mergeStats } from '../scripts/calibrate/fit-wind-model';
import type { ModelFitStats } from '@/lib/types';

/** Stand-in for what a fresh fit measures. */
const fresh: ModelFitStats = {
  r2: 0.61,
  adj_r2: 0.609,
  n: 900,
  rmse: 7.9,
  period_start: '2022-01-01',
  period_end: '2024-06-30',
  source: 'nafas-pm25 x era5-weather 2022-2023',
  specification: 'lagged_pm25 + same_day_wind',
  holdout: { h1: { hybrid: 6.9, persistence: 6.1 } },
};

describe('mergeStats', () => {
  it('keeps annotations a migration stamped on', () => {
    const merged = mergeStats(
      { r2: 0.585, n: 709, station_mix_changed_at: '2026-08-19', station_mix_note: 'AirGradient added' },
      fresh,
    );
    expect(merged.station_mix_changed_at).toBe('2026-08-19');
    expect(merged.station_mix_note).toBe('AirGradient added');
  });

  it('replaces every measured key with the new fit', () => {
    const merged = mergeStats({ r2: 0.585, adj_r2: 0.584, n: 709, rmse: 8.31 }, fresh);
    expect(merged.r2).toBe(0.61);
    expect(merged.adj_r2).toBe(0.609);
    expect(merged.n).toBe(900);
    expect(merged.rmse).toBe(7.9);
  });

  it('drops a measured key the new fit no longer emits', () => {
    // The regression this exists for. A plain `{...existing, ...fresh}` would
    // carry `holdout` through untouched; here the fit still emits one, so the
    // stale value must lose either way.
    const stale: ModelFitStats = { r2: 0.585, n: 709, rmse: 8.31, holdout: { h1: { hybrid: 7.41, persistence: 6.29 } } };
    const withoutHoldout = { ...fresh };
    delete (withoutHoldout as Record<string, unknown>).holdout;

    const merged = mergeStats(stale, withoutHoldout as ModelFitStats);
    expect(merged.holdout, 'a fit that measured no holdout must not inherit one').toBeUndefined();
  });

  it('never lets a stale measurement outlive the fit that produced it', () => {
    const merged = mergeStats({ ...fresh, r2: 0.1, holdout: { h1: { hybrid: 99, persistence: 99 } } }, fresh);
    // Everything measured comes from `fresh`; nothing from the old row survives.
    expect(merged.r2).toBe(fresh.r2);
    expect(merged.holdout).toEqual(fresh.holdout);
  });

  it('handles a row that has no stats yet', () => {
    expect(mergeStats(null, fresh)).toEqual(fresh);
    expect(mergeStats(undefined, fresh)).toEqual(fresh);
    expect(mergeStats({}, fresh)).toEqual(fresh);
  });

  it('does not mutate its inputs', () => {
    const existing = { r2: 0.585, station_mix_changed_at: '2026-08-19' };
    const snapshot = { ...existing };
    mergeStats(existing, fresh);
    expect(existing).toEqual(snapshot);
  });
});
