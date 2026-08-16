import { describe, expect, it } from 'vitest';
import {
  airQualityUrl,
  parseOpenMeteoAirQuality,
  parseOpenMeteoTime,
  parseOpenMeteoWeather,
  weatherUrl,
} from '../scripts/lib/openmeteo';

/**
 * Open-Meteo's parallel-array format is compact and completely unforgiving: one
 * short array and every subsequent value silently belongs to the wrong hour.
 * Add to that the two live surprises — timestamps with no zone, and values the
 * schema's CHECK constraints will reject — and every test here maps to a way
 * the ingestion would otherwise fail quietly or fail loudly at the database.
 */

const payload = (over: Record<string, unknown> = {}) => ({
  latitude: -6.18,
  longitude: 106.83,
  utc_offset_seconds: 0,
  timezone: 'GMT',
  hourly: {
    time: ['2026-08-16T00:00', '2026-08-16T01:00', '2026-08-16T02:00'],
    temperature_2m: [28.1, 28.4, 29.4],
    wind_speed_10m: [1.2, 2.5, 2.89],
    wind_direction_10m: [10, 180, 99],
    wind_gusts_10m: [3.1, 4.0, 5.2],
    relative_humidity_2m: [88, 86, 84],
    precipitation: [0, 0.2, 0],
    boundary_layer_height: [300, 500, 865],
    ...over,
  },
});

describe('parseOpenMeteoTime', () => {
  it('reads a zone-less Open-Meteo timestamp as UTC', () => {
    // The trap: `new Date('2026-08-16T00:00')` is *local* time in JavaScript,
    // which is right on a UTC CI runner and seven hours wrong on a WIB laptop.
    expect(parseOpenMeteoTime('2026-08-16T00:00')?.toISOString()).toBe('2026-08-16T00:00:00.000Z');
  });

  it('still accepts an explicitly zoned timestamp', () => {
    expect(parseOpenMeteoTime('2026-08-16T07:00:00+07:00')?.toISOString()).toBe('2026-08-16T00:00:00.000Z');
    expect(parseOpenMeteoTime('2026-08-16T00:00:00Z')?.toISOString()).toBe('2026-08-16T00:00:00.000Z');
  });

  it('refuses anything else rather than letting Date improvise', () => {
    for (const junk of ['16/08/2026', '2026-08-16', '', null, 42, undefined]) {
      expect(parseOpenMeteoTime(junk)).toBeNull();
    }
  });
});

describe('parseOpenMeteoWeather', () => {
  it('maps the parallel arrays onto hours', () => {
    const r = parseOpenMeteoWeather(payload());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.hours).toHaveLength(3);
    expect(r.hours[2]).toMatchObject({
      observedAt: '2026-08-16T02:00:00.000Z',
      tempC: 29.4,
      windSpeedMs: 2.89,
      windDirDeg: 99,
      blhM: 865,
    });
  });

  it('normalises a 360-degree bearing to 0', () => {
    // `wind_dir_deg` has a `>= 0 and < 360` CHECK. Open-Meteo returning 360 for
    // due north would fail the insert and take the whole batch with it.
    const r = parseOpenMeteoWeather(payload({ wind_direction_10m: [360, 361, -10] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.hours.map((h) => h.windDirDeg)).toEqual([0, 1, 350]);
  });

  it('nulls values that would violate a CHECK, and counts them', () => {
    const r = parseOpenMeteoWeather(
      payload({ relative_humidity_2m: [88, 140, -3], wind_speed_10m: [1.2, -1, 2.89] }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.hours.map((h) => h.rhPct)).toEqual([88, null, null]);
    expect(r.hours.map((h) => h.windSpeedMs)).toEqual([1.2, null, 2.89]);
    expect(r.clamped).toEqual({ rh_pct: 2, wind_speed_ms: 1 });
  });

  it('survives a short or missing value array without shifting hours', () => {
    // The failure this prevents: indexing past the end and pairing hour 2 with
    // hour 0's temperature.
    const r = parseOpenMeteoWeather(payload({ temperature_2m: [28.1], boundary_layer_height: undefined }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.hours.map((h) => h.tempC)).toEqual([28.1, null, null]);
    expect(r.hours.map((h) => h.blhM)).toEqual([null, null, null]);
    expect(r.hours.map((h) => h.windSpeedMs)).toEqual([1.2, 2.5, 2.89]);
  });

  it('treats nulls inside an array as missing, not as zero', () => {
    const r = parseOpenMeteoWeather(payload({ wind_speed_10m: [1.2, null, 2.89] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.hours[1].windSpeedMs).toBeNull();
  });

  it('drops hours after maxTime — the observation table takes no forecast', () => {
    // The mistake this guards: a forecast hour written to
    // `weather_observations` is read back by the rollup as though it were
    // measured, and the model ends up calibrated on its own predictions.
    const r = parseOpenMeteoWeather(payload(), { maxTime: new Date('2026-08-16T01:00:00Z') });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.hours.map((h) => h.observedAt)).toEqual(['2026-08-16T00:00:00.000Z', '2026-08-16T01:00:00.000Z']);
  });

  it('counts unparseable timestamps and keeps the rest', () => {
    const r = parseOpenMeteoWeather(payload({ time: ['2026-08-16T00:00', 'nonsense', '2026-08-16T02:00'] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.hours).toHaveLength(2);
    expect(r.badTimestamps).toBe(1);
  });

  it('reports the API error envelope', () => {
    const r = parseOpenMeteoWeather({ error: true, reason: 'Parameter forecast_days is out of allowed range' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('api-error');
    expect(r.detail).toContain('forecast_days');
  });

  it('rejects a payload with no hourly block', () => {
    expect(parseOpenMeteoWeather({ latitude: 1 }).ok).toBe(false);
    expect(parseOpenMeteoWeather({ hourly: { time: 'not-an-array' } }).ok).toBe(false);
    expect(parseOpenMeteoWeather(null).ok).toBe(false);
  });
});

describe('parseOpenMeteoAirQuality', () => {
  const aqPayload = {
    latitude: -6.18,
    longitude: 106.83,
    hourly: { time: ['2026-08-17T00:00', '2026-08-17T01:00'], pm2_5: [61.7, null] },
  };

  it('reads native µg/m³ with no AQI inversion', () => {
    const r = parseOpenMeteoAirQuality(aqPayload);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.hours).toEqual([
      { observedAt: '2026-08-17T00:00:00.000Z', pm25: 61.7 },
      { observedAt: '2026-08-17T01:00:00.000Z', pm25: null },
    ]);
  });

  it('nulls a negative concentration', () => {
    const r = parseOpenMeteoAirQuality({ hourly: { time: ['2026-08-17T00:00'], pm2_5: [-1] } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.hours[0].pm25).toBeNull();
    expect(r.clamped).toEqual({ pm2_5: 1 });
  });
});

describe('URL builders', () => {
  it('requests m/s and UTC — the units and zone everything downstream assumes', () => {
    const url = weatherUrl(-6.1862, 106.834, 2, 1);
    expect(url).toContain('wind_speed_unit=ms');
    expect(url).toContain('timezone=UTC');
    expect(url).toContain('past_days=2');
    expect(url).toContain('forecast_days=1');
    // boundary_layer_height is the non-obvious one — the M6 feature candidate.
    expect(url).toContain('boundary_layer_height');
  });

  it('points the air-quality endpoint at the CAMS host', () => {
    const url = airQualityUrl(-6.1862, 106.834, 5);
    expect(url).toContain('air-quality-api.open-meteo.com');
    expect(url).toContain('hourly=pm2_5');
    expect(url).toContain('forecast_days=5');
  });
});
