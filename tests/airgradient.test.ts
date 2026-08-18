import { describe, expect, it } from 'vitest';
import {
  CORRECTION_ID,
  correctAirGradientPm25,
  parseAirGradientWorld,
} from '../scripts/lib/airgradient';

/**
 * The correction is the whole reason this source is usable: raw optical
 * readings overread in humid tropical air (the unit at BMKG HQ read ~52 raw
 * against a co-located reference BAM's ~29). These tests pin the published
 * EPA/Barkjohn piecewise form, its continuity, and the parser's refusal to
 * store anything half-corrected.
 */

describe('correctAirGradientPm25', () => {
  it('applies the low-range formula exactly (raw < 30)', () => {
    // 0.524·20 − 0.0862·50 + 5.75 = 10.48 − 4.31 + 5.75 = 11.92
    expect(correctAirGradientPm25(20, 50)).toBeCloseTo(11.9, 1);
  });

  it('applies the mid-range formula exactly (50 ≤ raw < 210)', () => {
    // 0.786·100 − 0.0862·60 + 5.75 = 78.6 − 5.172 + 5.75 = 79.178
    expect(correctAirGradientPm25(100, 60)).toBeCloseTo(79.2, 1);
  });

  it('applies the high-range polynomial with no RH term (raw ≥ 260)', () => {
    // 2.966 + 0.69·300 + 8.84e-4·300² = 2.966 + 207 + 79.56 = 289.526 — RH irrelevant.
    expect(correctAirGradientPm25(300, 20)).toBeCloseTo(289.5, 1);
    expect(correctAirGradientPm25(300, 90)).toBeCloseTo(289.5, 1);
  });

  it('is continuous across every piecewise boundary', () => {
    // A discontinuity would put a permanent phantom step into any daily
    // average whose hours straddle the boundary concentration.
    for (const rh of [30, 60, 90]) {
      for (const boundary of [30, 50, 210, 260]) {
        const below = correctAirGradientPm25(boundary - 0.01, rh)!;
        const above = correctAirGradientPm25(boundary + 0.01, rh)!;
        expect(Math.abs(above - below), `boundary ${boundary} @ RH ${rh}`).toBeLessThan(0.5);
      }
    }
  });

  it('corrects the humid-tropics overread downward at typical Jakarta values', () => {
    // The whole point: raw 52 in humid air must come down substantially.
    const corrected = correctAirGradientPm25(52, 75)!;
    expect(corrected).toBeLessThan(52 * 0.85);
    expect(corrected).toBeGreaterThan(20);
  });

  it('increases with raw PM at fixed RH, decreases with RH at fixed raw', () => {
    let prev = -Infinity;
    for (let raw = 0; raw <= 400; raw += 1) {
      const c = correctAirGradientPm25(raw, 60)!;
      expect(c).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = c;
    }
    // RH only matters below the high-range branch.
    expect(correctAirGradientPm25(50, 90)!).toBeLessThan(correctAirGradientPm25(50, 30)!);
  });

  it('clamps negative outputs to 0 rather than reporting negative air', () => {
    // Tiny raw + high RH drives the linear form negative: 0.524·1 − 0.0862·95 + 5.75 ≈ −1.9
    expect(correctAirGradientPm25(1, 95)).toBe(0);
  });

  it('clamps absurd RH into [0, 100] instead of extrapolating', () => {
    expect(correctAirGradientPm25(40, 150)).toBe(correctAirGradientPm25(40, 100));
    expect(correctAirGradientPm25(40, -5)).toBe(correctAirGradientPm25(40, 0));
  });

  it('returns null for garbage rather than a confident number', () => {
    expect(correctAirGradientPm25(Number.NaN, 50)).toBeNull();
    expect(correctAirGradientPm25(-3, 50)).toBeNull();
    expect(correctAirGradientPm25(5000, 50)).toBeNull();
    expect(correctAirGradientPm25(40, Number.NaN)).toBeNull();
  });
});

describe('parseAirGradientWorld', () => {
  const NOW = new Date('2026-08-18T13:00:00.000Z');
  const OPTS = { now: NOW, staleHours: 6, wanted: new Set(['199980', '77247']) };

  /** Shape observed live on 2026-08-18 — not invented for the test. */
  const liveRow = (over: Record<string, unknown> = {}) => ({
    locationId: 199980,
    locationName: 'BMKG 1',
    latitude: -6.1557694,
    longitude: 106.8423941,
    offline: false,
    pm02: 52,
    rhum: 75,
    atmp: 29,
    timestamp: '2026-08-18T12:25:30.000Z',
    publicContributorName: null,
    ...over,
  });

  it('extracts wanted stations, corrects them, and floors timestamps to the hour', () => {
    const result = parseAirGradientWorld([liveRow(), liveRow({ locationId: 77247, pm02: 37.2, rhum: 60 })], OPTS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.readings).toHaveLength(2);

    const bmkg = result.readings.find((r) => r.locationId === '199980')!;
    expect(bmkg.pm25Corrected).toBeCloseTo(correctAirGradientPm25(52, 75)!, 5);
    expect(bmkg.observedAt).toBe('2026-08-18T12:00:00.000Z'); // floored, not 12:25:30
    // Provenance: raw value, RH and the formula id all survive into `raw`.
    const raw = bmkg.raw as { pm02_raw: number; rhum: number; correction: string; measured_at: string };
    expect(raw.pm02_raw).toBe(52);
    expect(raw.rhum).toBe(75);
    expect(raw.correction).toBe(CORRECTION_ID);
    expect(raw.measured_at).toBe('2026-08-18T12:25:30.000Z');
  });

  it('ignores the other ~2,700 unwanted rows', () => {
    const result = parseAirGradientWorld(
      [liveRow({ locationId: 74580 }), liveRow({ locationId: 69782 }), liveRow()],
      OPTS,
    );
    if (!result.ok) throw new Error('expected ok');
    expect(result.readings).toHaveLength(1);
  });

  it('drops a reading without RH instead of half-correcting it', () => {
    const result = parseAirGradientWorld([liveRow({ rhum: null })], OPTS);
    if (!result.ok) throw new Error('expected ok');
    expect(result.readings).toHaveLength(0);
    expect(result.skipped[0]).toMatchObject({ locationId: '199980', reason: 'no-rh' });
  });

  it('skips offline and stale stations with distinct reasons', () => {
    const result = parseAirGradientWorld(
      [liveRow({ offline: true }), liveRow({ locationId: 77247, timestamp: '2026-08-18T02:00:00.000Z' })],
      OPTS,
    );
    if (!result.ok) throw new Error('expected ok');
    expect(result.readings).toHaveLength(0);
    expect(result.skipped.map((s) => s.reason).sort()).toEqual(['offline', 'stale']);
  });

  it('reports seeded ids missing from the payload — how these stations die', () => {
    const result = parseAirGradientWorld([liveRow()], OPTS);
    if (!result.ok) throw new Error('expected ok');
    expect(result.missing).toEqual(['77247']);
  });

  it('rejects a malformed payload without throwing', () => {
    expect(parseAirGradientWorld({ not: 'an array' }, OPTS).ok).toBe(false);
    expect(parseAirGradientWorld([], OPTS).ok).toBe(false);
    expect(parseAirGradientWorld(null, OPTS).ok).toBe(false);
  });

  it('survives malformed rows among the wanted ids', () => {
    const result = parseAirGradientWorld(
      [{ locationId: 199980, pm02: 'high', timestamp: 42 }, liveRow({ locationId: 77247 })],
      OPTS,
    );
    if (!result.ok) throw new Error('expected ok');
    expect(result.readings).toHaveLength(1);
    expect(result.skipped[0].locationId).toBe('199980');
  });
});
