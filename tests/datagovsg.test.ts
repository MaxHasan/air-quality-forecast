import { describe, expect, it } from 'vitest';
import { parseDataGovSgPm25, SG_REGIONS } from '../scripts/lib/datagovsg';

/**
 * data.gov.sg is the well-behaved feed of the two, which makes its edge cases
 * easier to overlook: items arrive newest-first, the same observation hour can
 * appear more than once as NEA revises it, and a missing sensor value is a
 * negative sentinel rather than a null.
 *
 * The fixture mirrors a live 2026-08-16 response.
 */

const item = (
  timestamp: string,
  readings: Partial<Record<string, number>>,
  updatedTimestamp?: string,
) => ({
  date: timestamp.slice(0, 10),
  timestamp,
  ...(updatedTimestamp ? { updatedTimestamp } : {}),
  readings: { pm25_one_hourly: readings },
});

const wrap = (items: unknown[]) => ({
  code: 0,
  errorMsg: '',
  data: {
    regionMetadata: SG_REGIONS.map((name) => ({ name, labelLocation: { latitude: 1.35, longitude: 103.8 } })),
    items,
  },
});

const FULL_HOUR = { north: 27, east: 14, south: 26, west: 27, central: 31 };

describe('parseDataGovSgPm25 — the happy path', () => {
  it('flattens each item into one reading per region', () => {
    const r = parseDataGovSgPm25(wrap([item('2026-08-16T21:00:00+08:00', FULL_HOUR)]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.readings).toHaveLength(5);
    expect(r.readings.map((x) => x.region).sort()).toEqual(['central', 'east', 'north', 'south', 'west']);
  });

  it('converts +08:00 wall time to the UTC instant', () => {
    // 21:00 SGT is 13:00 UTC. Storing the wall clock would put the reading
    // eight hours into the future and into tomorrow's bucket.
    const r = parseDataGovSgPm25(wrap([item('2026-08-16T21:00:00+08:00', { central: 31 })]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.readings[0].observedAt).toBe('2026-08-16T13:00:00.000Z');
    expect(r.readings[0].pm25).toBe(31);
  });

  it('returns readings in chronological order regardless of response order', () => {
    // The live API returns newest-first; downstream logs read far better
    // chronologically, and sorting here means no caller has to remember.
    const r = parseDataGovSgPm25(
      wrap([
        item('2026-08-16T21:00:00+08:00', { central: 31 }),
        item('2026-08-16T19:00:00+08:00', { central: 29 }),
        item('2026-08-16T20:00:00+08:00', { central: 30 }),
      ]),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.readings.map((x) => x.pm25)).toEqual([29, 30, 31]);
  });

  it('handles a whole day, which is what `?date=` returns', () => {
    const items = Array.from({ length: 24 }, (_, h) =>
      item(`2026-08-16T${String(h).padStart(2, '0')}:00:00+08:00`, FULL_HOUR),
    );
    const r = parseDataGovSgPm25(wrap(items));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.readings).toHaveLength(24 * 5);
  });
});

describe('parseDataGovSgPm25 — revisions and duplicates', () => {
  it('keeps the newest revision of a repeated hour', () => {
    const r = parseDataGovSgPm25(
      wrap([
        item('2026-08-16T21:00:00+08:00', { central: 31 }, '2026-08-16T21:05:00+08:00'),
        item('2026-08-16T21:00:00+08:00', { central: 44 }, '2026-08-16T21:45:00+08:00'),
      ]),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.readings).toHaveLength(1);
    expect(r.readings[0].pm25).toBe(44);
    expect(r.skipped.superseded).toBe(1);
  });

  it('is order-independent about which revision wins', () => {
    // The API does not order by `updatedTimestamp`, so array position must not
    // decide. Same two items, reversed: same answer.
    const r = parseDataGovSgPm25(
      wrap([
        item('2026-08-16T21:00:00+08:00', { central: 44 }, '2026-08-16T21:45:00+08:00'),
        item('2026-08-16T21:00:00+08:00', { central: 31 }, '2026-08-16T21:05:00+08:00'),
      ]),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.readings[0].pm25).toBe(44);
  });

  it('folds sub-hour timestamps into their hour', () => {
    const r = parseDataGovSgPm25(
      wrap([item('2026-08-16T21:30:00+08:00', { central: 31 }, '2026-08-16T21:35:00+08:00')]),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.readings[0].observedAt).toBe('2026-08-16T13:00:00.000Z');
  });
});

describe('parseDataGovSgPm25 — bad values are dropped, not fatal', () => {
  it('drops negative sentinels but keeps the rest of the hour', () => {
    // The schema's `pm25_ugm3 >= 0` CHECK would reject the whole batch at the
    // database; one absent sensor must not cost four good readings.
    const r = parseDataGovSgPm25(wrap([item('2026-08-16T21:00:00+08:00', { ...FULL_HOUR, east: -1 })]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.readings).toHaveLength(4);
    expect(r.readings.some((x) => x.region === 'east')).toBe(false);
    expect(r.skipped.badValue).toBe(1);
  });

  it('drops non-numeric and null values', () => {
    const r = parseDataGovSgPm25(
      wrap([item('2026-08-16T21:00:00+08:00', { north: 27, south: null as never, east: '14' as never })]),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.readings).toHaveLength(1);
    expect(r.skipped.badValue).toBe(2);
  });

  it('ignores region names it does not recognise', () => {
    // NEA adding a sixth region should be visible in the logs, not fatal.
    const r = parseDataGovSgPm25(wrap([item('2026-08-16T21:00:00+08:00', { ...FULL_HOUR, northeast: 20 })]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.readings).toHaveLength(5);
  });

  it('drops items with an unusable timestamp', () => {
    const r = parseDataGovSgPm25(
      wrap([
        // No offset — would be read in the runner's zone.
        item('2026-08-16T21:00:00', { central: 99 }),
        item('2026-08-16T20:00:00+08:00', { central: 30 }),
      ]),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.readings).toHaveLength(1);
    expect(r.readings[0].pm25).toBe(30);
    expect(r.skipped.badTimestamp).toBe(1);
  });

  it('drops hours after `maxTime`', () => {
    const r = parseDataGovSgPm25(
      wrap([
        item('2026-08-16T20:00:00+08:00', { central: 30 }),
        item('2026-08-16T23:00:00+08:00', { central: 31 }),
      ]),
      { maxTime: new Date('2026-08-16T13:30:00Z') }, // = 21:30 SGT
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.readings).toHaveLength(1);
    expect(r.skipped.future).toBe(1);
  });
});

describe('parseDataGovSgPm25 — envelope failures', () => {
  it('reports a non-zero code with the API message', () => {
    // What a 404 for an unavailable date actually returns.
    const r = parseDataGovSgPm25({ code: 17, name: 'REAL_TIME_API_DATA_NOT_FOUND', data: null, errorMsg: 'Data not found' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('api-error');
    expect(r.detail).toContain('Data not found');
  });

  it('rejects a payload with no items array', () => {
    const r = parseDataGovSgPm25({ code: 0, data: {} });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('malformed');
  });

  it('distinguishes an empty day from a malformed one', () => {
    const r = parseDataGovSgPm25(wrap([]));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('no-items');
  });

  it('rejects non-objects', () => {
    for (const junk of [null, undefined, 'ok', 42, []]) {
      expect(parseDataGovSgPm25(junk).ok).toBe(false);
    }
  });
});
