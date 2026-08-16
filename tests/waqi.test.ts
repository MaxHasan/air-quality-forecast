import { describe, expect, it } from 'vitest';
import { EPA_PM25_BREAKPOINTS_2024 } from '@/lib/aqi';
import { floorToHourUtc, guessNetwork, parseWaqiFeed } from '../scripts/lib/waqi';

/**
 * The WAQI parser is the narrowest point every Indonesian reading passes
 * through, and almost all of its interesting behaviour concerns payloads that
 * are *not* the documented happy path. Each fixture below is a shape observed
 * live on 2026-08-16, not one invented to make a test pass.
 */

const NOW = new Date('2026-08-16T13:30:00Z');
const OPTS = { now: NOW, staleHours: 6 };

/** @8294 Kemayoran (BMKG) — note `time.iso` renders with a +07:00 offset. */
const KEMAYORAN = {
  status: 'ok',
  data: {
    idx: 8294,
    aqi: 119,
    time: { s: '2026-08-16 20:00:00', tz: '+07:00', v: 1786910400, iso: '2026-08-16T20:00:00+07:00' },
    city: { name: 'Kemayoran, Indonesia', geo: [-6.155, 106.846] },
    attributions: [
      { url: 'http://www.bmkg.go.id/', name: 'BMKG | Badan Meteorologi, Klimatologi dan Geofisika' },
      { url: 'https://waqi.info/', name: 'World Air Quality Index Project' },
    ],
    iaqi: { dew: { v: 26 }, h: { v: 88 }, p: { v: 1013 }, pm25: { v: 119 }, t: { v: 28 }, w: { v: 3 } },
  },
};

/** @-416842 Jakarta GBK (KLHK) — same instant, rendered as Zulu instead. */
const GBK = {
  status: 'ok',
  data: {
    idx: -416842,
    aqi: 78,
    time: { s: '2026-08-16 20:00:00', tz: '+07:00', v: 1786885200, iso: '2026-08-16T13:00:00Z' },
    city: { name: 'Jakarta GBK' },
    attributions: [{ url: 'https://kemenlh.go.id/', name: 'Kementerian Lingkungan Hidup Dan Kehutanan' }],
    iaqi: { co: { v: 0 }, no2: { v: 17 }, o3: { v: 55 }, pm10: { v: 32 }, pm25: { v: 78 }, so2: { v: 1 } },
  },
};

describe('parseWaqiFeed — the happy path', () => {
  it('inverts the AQI sub-index to a concentration', () => {
    const r = parseWaqiFeed(KEMAYORAN, OPTS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // AQI 119 sits in the pre-2024 101-150 band: 35.5 + (19.9/49)*18 = 42.8.
    // Storing 119 as µg/m³ — the mistake this whole layer exists to prevent —
    // would nearly triple the reading.
    expect(r.aqi).toBe(119);
    expect(r.pm25).toBeCloseTo(42.8, 1);
    expect(r.aqiTable).toBe('epa-pre-2024');
  });

  it('stores the instant, not the wall clock, whichever offset WAQI renders', () => {
    // Same moment, two representations. Both must land on the same UTC instant,
    // or Jakarta's two stations would disagree about which hour they measured.
    const a = parseWaqiFeed(KEMAYORAN, OPTS);
    const b = parseWaqiFeed(GBK, OPTS);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.observedAt).toBe('2026-08-16T13:00:00.000Z');
    expect(b.observedAt).toBe(a.observedAt);
  });

  it('carries the station name and attributions through', () => {
    const r = parseWaqiFeed(KEMAYORAN, OPTS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.stationName).toBe('Kemayoran, Indonesia');
    expect(r.attributions).toContain('BMKG | Badan Meteorologi, Klimatologi dan Geofisika');
    expect(r.ageHours).toBeCloseTo(0.5, 6);
  });

  it('honours a non-default breakpoint table', () => {
    const r = parseWaqiFeed(KEMAYORAN, { ...OPTS, table: EPA_PM25_BREAKPOINTS_2024 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.aqiTable).toBe('epa-2024');
    // Same band bounds above 35.5, so this particular AQI happens to agree —
    // which is exactly why the table is recorded on every row.
    expect(r.pm25).toBeCloseTo(42.8, 1);
  });
});

describe('parseWaqiFeed — the "Unknown ID" shape', () => {
  /**
   * The one that catches people out: HTTP 200, outer `status: "ok"`, and the
   * failure buried inside `data` as an object — not the documented error
   * *string*. Nothing above the parser can detect this.
   */
  const UNKNOWN = { status: 'ok', data: { status: 'error', msg: 'Unknown ID' } };

  it('detects it structurally rather than by status code', () => {
    const r = parseWaqiFeed(UNKNOWN, OPTS);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('unknown-id');
    expect(r.detail).toBe('Unknown ID');
  });

  it('also handles the documented outer-error form', () => {
    const r = parseWaqiFeed({ status: 'error', data: 'Unknown ID' }, OPTS);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('unknown-id');
  });

  it('distinguishes a generic API error from a dead uid', () => {
    // A rate limit must not deactivate a healthy station.
    const r = parseWaqiFeed({ status: 'error', data: 'Over quota' }, OPTS);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('api-error');
  });

  it('does not mistake a bad token for a dead station', () => {
    // "Invalid key" arrives through the same channel as "Unknown ID". Reading it
    // as a dead uid would send the operator hunting for replacement sensors —
    // for all four stations at once — when one expired secret is the problem.
    const r = parseWaqiFeed({ status: 'error', data: 'Invalid key' }, OPTS);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('api-error');
  });
});

describe('parseWaqiFeed — stale feeds', () => {
  const staleFeed = (iso: string) => ({ ...GBK, data: { ...GBK.data, time: { ...GBK.data.time, iso } } });

  it('rejects a reading past the staleness budget', () => {
    // 7 hours old against a 6-hour budget. Writing it into the current hour
    // would fold air that has already blown away into today's average.
    const r = parseWaqiFeed(staleFeed('2026-08-16T06:00:00Z'), OPTS);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('stale');
    expect(r.ageHours).toBeCloseTo(7.5, 1);
    // The timestamp still comes back: the station is alive, so the dormancy
    // sweep must leave it alone.
    expect(r.observedAt).toBe('2026-08-16T06:00:00.000Z');
  });

  it('accepts a reading just inside the budget', () => {
    const r = parseWaqiFeed(staleFeed('2026-08-16T08:00:00Z'), OPTS);
    expect(r.ok).toBe(true);
  });

  it('reports staleness only for otherwise-valid readings', () => {
    // An old payload with no PM2.5 is a data gap, not a stale reading, and the
    // ingestion script treats the two differently.
    const old = { ...GBK, data: { ...GBK.data, time: { ...GBK.data.time, iso: '2026-08-16T00:00:00Z' }, iaqi: { o3: { v: 12 } } } };
    const r = parseWaqiFeed(old, OPTS);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('no-pm25');
  });
});

describe('parseWaqiFeed — timestamps it must refuse', () => {
  it('refuses an offset-less `time.iso`', () => {
    // `new Date('2026-08-16T20:00:00')` is parsed in the *runner's* zone: right
    // on a UTC CI box, seven hours wrong on a WIB laptop. Guessing is not an option.
    const r = parseWaqiFeed({ ...GBK, data: { ...GBK.data, time: { iso: '2026-08-16T20:00:00' } } }, OPTS);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('no-timestamp');
  });

  it('refuses a missing `time.iso` rather than falling back to `time.s`', () => {
    const r = parseWaqiFeed({ ...GBK, data: { ...GBK.data, time: { s: '2026-08-16 20:00:00', tz: '+07:00' } } }, OPTS);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('no-timestamp');
  });

  it('flags a wildly future timestamp as a timezone misread', () => {
    const r = parseWaqiFeed({ ...GBK, data: { ...GBK.data, time: { iso: '2026-08-16T20:00:00Z' } } }, OPTS);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('implausible-time');
  });

  it('tolerates a feed running a few minutes ahead of the clock', () => {
    const r = parseWaqiFeed({ ...GBK, data: { ...GBK.data, time: { iso: '2026-08-16T14:00:00Z' } } }, OPTS);
    expect(r.ok).toBe(true);
  });
});

describe('parseWaqiFeed — malformed and out-of-range payloads', () => {
  it('rejects non-objects', () => {
    for (const junk of [null, undefined, 'ok', 42, []]) {
      const r = parseWaqiFeed(junk, OPTS);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(['malformed', 'api-error']).toContain(r.reason);
    }
  });

  it('rejects a payload with no `data` object', () => {
    const r = parseWaqiFeed({ status: 'ok' }, OPTS);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('malformed');
  });

  it('rejects a non-numeric pm25 value', () => {
    const r = parseWaqiFeed({ ...GBK, data: { ...GBK.data, iaqi: { pm25: { v: '78' } } } }, OPTS);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('no-pm25');
  });

  it('rejects an AQI above the table rather than clamping to 500', () => {
    const r = parseWaqiFeed({ ...GBK, data: { ...GBK.data, iaqi: { pm25: { v: 900 } } } }, OPTS);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('out-of-range');
  });
});

describe('floorToHourUtc', () => {
  it('collapses sub-hour precision so one station-hour is one row', () => {
    expect(floorToHourUtc(new Date('2026-08-16T13:47:31.500Z')).toISOString()).toBe('2026-08-16T13:00:00.000Z');
    expect(floorToHourUtc(new Date('2026-08-16T13:00:00Z')).toISOString()).toBe('2026-08-16T13:00:00.000Z');
  });

  it('does not mutate its argument', () => {
    const d = new Date('2026-08-16T13:47:00Z');
    floorToHourUtc(d);
    expect(d.toISOString()).toBe('2026-08-16T13:47:00.000Z');
  });
});

describe('guessNetwork', () => {
  it('recognises the four networks WAQI carries for us', () => {
    expect(guessNetwork([{ name: 'BMKG | Badan Meteorologi', url: 'http://www.bmkg.go.id/' }])).toBe('bmkg');
    expect(guessNetwork([{ name: 'Kementerian Lingkungan Hidup', url: 'https://kemenlh.go.id/' }])).toBe('klhk');
    expect(guessNetwork([{ name: 'NEA - Singapore National Environment Agency' }])).toBe('nea');
    expect(guessNetwork([{ name: 'Nafas Indonesia' }])).toBe('nafas');
  });

  it('returns null rather than guessing', () => {
    // `stations.network` is nullable precisely so an unconfirmed network is
    // recorded as unknown instead of being invented.
    expect(guessNetwork([{ name: 'World Air Quality Index Project', url: 'https://waqi.info/' }])).toBeNull();
    expect(guessNetwork([])).toBeNull();
  });
});
