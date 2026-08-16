/**
 * openmeteo.ts — parsing Open-Meteo's parallel-array hourly payloads.
 *
 * Two endpoints, one shape: `hourly.time` is the spine and every other key is
 * an array of the same length, positionally aligned. That format is compact and
 * completely unforgiving — one short array and every subsequent value belongs to
 * the wrong hour, silently. So every array is indexed defensively and anything
 * beyond `time.length` is ignored rather than assumed.
 *
 * ---------------------------------------------------------------------------
 * The two traps, both observed live
 * ---------------------------------------------------------------------------
 *
 * 1. **`time` strings carry no zone.** With `timezone=UTC` the API still emits
 *    `2026-08-14T00:00`, not `...Z`. `new Date('2026-08-14T00:00')` is parsed as
 *    *local* time by JavaScript, which is right on a UTC CI runner and seven
 *    hours wrong on a WIB laptop. We append the `Z` ourselves, and refuse any
 *    string that does not match the expected shape rather than letting `Date`
 *    improvise.
 *
 * 2. **The database has CHECK constraints and the API does not know that.**
 *    `wind_dir_deg` must be in `[0, 360)`, and Open-Meteo will happily return
 *    360 for due north — a value that fails the insert and takes the whole
 *    batch with it. Direction is normalised; other out-of-range values are
 *    nulled and counted. A nulled field costs one hour of one variable; a
 *    rejected batch costs the run.
 */

import type { IsoTimestamp } from '../../src/lib/types';

/** One hour of weather, already in the units and ranges the schema expects. */
export interface WeatherHour {
  observedAt: IsoTimestamp;
  tempC: number | null;
  windSpeedMs: number | null;
  /** Normalised to `[0, 360)`. Meteorological: the direction wind blows *from*. */
  windDirDeg: number | null;
  windGustsMs: number | null;
  rhPct: number | null;
  precipMm: number | null;
  blhM: number | null;
}

/** One hour of CAMS PM2.5, µg/m³. */
export interface AirQualityHour {
  observedAt: IsoTimestamp;
  pm25: number | null;
}

export interface OpenMeteoParsed<T> {
  ok: true;
  hours: T[];
  /** Values dropped for failing a schema CHECK, by field. */
  clamped: Record<string, number>;
  /** Timestamps that could not be parsed. */
  badTimestamps: number;
}

export interface OpenMeteoRejected {
  ok: false;
  reason: 'malformed' | 'api-error' | 'no-hourly';
  detail: string;
}

export type OpenMeteoResult<T> = OpenMeteoParsed<T> | OpenMeteoRejected;

export interface OpenMeteoParseOptions {
  /** Drop hours strictly after this instant. Used to keep forecast out of the observation table. */
  maxTime?: Date;
  /** Drop hours strictly before this instant. */
  minTime?: Date;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `YYYY-MM-DDTHH:MM` — exactly what Open-Meteo emits with `timezone=UTC`. */
const NAIVE_HOUR = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/;

/**
 * Interpret an Open-Meteo `hourly.time` entry as UTC.
 *
 * Accepts an already-zoned string too, so that a future switch to a local
 * `timezone=` parameter does not silently re-label every hour.
 */
export function parseOpenMeteoTime(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (NAIVE_HOUR.test(s)) {
    const d = new Date(`${s}:00Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** Common envelope checks for both endpoints. */
function openHourly(payload: unknown): { time: unknown[]; hourly: Record<string, unknown> } | OpenMeteoRejected {
  if (!isRecord(payload)) {
    return { ok: false, reason: 'malformed', detail: `expected an object, got ${typeof payload}` };
  }
  if (payload.error === true) {
    const reason = typeof payload.reason === 'string' ? payload.reason : 'unspecified';
    return { ok: false, reason: 'api-error', detail: reason };
  }
  const hourly = isRecord(payload.hourly) ? payload.hourly : null;
  if (!hourly || !Array.isArray(hourly.time)) {
    return { ok: false, reason: 'no-hourly', detail: '`hourly.time` is not an array' };
  }
  return { time: hourly.time, hourly };
}

/** Read `hourly[key][i]`, tolerating a missing or short array. */
function at(hourly: Record<string, unknown>, key: string, i: number): number | null {
  const arr = hourly[key];
  if (!Array.isArray(arr) || i >= arr.length) return null;
  const v = arr[i];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Keep a value only if it satisfies the column's CHECK, counting rejections.
 * Returning `null` rather than clamping keeps a bad reading out of the average
 * instead of dragging it toward an arbitrary boundary.
 */
function guard(
  value: number | null,
  ok: (v: number) => boolean,
  field: string,
  counts: Record<string, number>,
): number | null {
  if (value === null) return null;
  if (ok(value)) return value;
  counts[field] = (counts[field] ?? 0) + 1;
  return null;
}

/**
 * Parse `GET /v1/forecast` with the seven hourly variables the schema stores.
 *
 * The caller decides which hours survive: `ingest/weather.ts` passes
 * `maxTime = now` because `weather_observations` is an *observation* table and
 * forecast hours belong in `predictions.inputs`, not in it.
 */
export function parseOpenMeteoWeather(
  payload: unknown,
  options: OpenMeteoParseOptions = {},
): OpenMeteoResult<WeatherHour> {
  const opened = openHourly(payload);
  if ('ok' in opened) return opened;
  const { time, hourly } = opened;

  const clamped: Record<string, number> = {};
  const hours: WeatherHour[] = [];
  let badTimestamps = 0;

  const minMs = options.minTime?.getTime() ?? Number.NEGATIVE_INFINITY;
  const maxMs = options.maxTime?.getTime() ?? Number.POSITIVE_INFINITY;

  for (let i = 0; i < time.length; i += 1) {
    const t = parseOpenMeteoTime(time[i]);
    if (!t) {
      badTimestamps += 1;
      continue;
    }
    const ms = t.getTime();
    if (ms < minMs || ms > maxMs) continue;

    // 360 and 0 are the same bearing, but only one of them satisfies
    // `wind_dir_deg < 360`. Normalise rather than reject: this is a
    // representation difference, not bad data.
    const dirRaw = at(hourly, 'wind_direction_10m', i);
    const windDirDeg = dirRaw === null ? null : ((dirRaw % 360) + 360) % 360;

    hours.push({
      observedAt: t.toISOString(),
      tempC: at(hourly, 'temperature_2m', i),
      windSpeedMs: guard(at(hourly, 'wind_speed_10m', i), (v) => v >= 0, 'wind_speed_ms', clamped),
      windDirDeg,
      windGustsMs: guard(at(hourly, 'wind_gusts_10m', i), (v) => v >= 0, 'wind_gusts_ms', clamped),
      rhPct: guard(at(hourly, 'relative_humidity_2m', i), (v) => v >= 0 && v <= 100, 'rh_pct', clamped),
      precipMm: guard(at(hourly, 'precipitation', i), (v) => v >= 0, 'precip_mm', clamped),
      blhM: guard(at(hourly, 'boundary_layer_height', i), (v) => v >= 0, 'blh_m', clamped),
    });
  }

  return { ok: true, hours, clamped, badTimestamps };
}

/** Parse `GET /v1/air-quality` with `hourly=pm2_5`. Native µg/m³. */
export function parseOpenMeteoAirQuality(
  payload: unknown,
  options: OpenMeteoParseOptions = {},
): OpenMeteoResult<AirQualityHour> {
  const opened = openHourly(payload);
  if ('ok' in opened) return opened;
  const { time, hourly } = opened;

  const clamped: Record<string, number> = {};
  const hours: AirQualityHour[] = [];
  let badTimestamps = 0;

  const minMs = options.minTime?.getTime() ?? Number.NEGATIVE_INFINITY;
  const maxMs = options.maxTime?.getTime() ?? Number.POSITIVE_INFINITY;

  for (let i = 0; i < time.length; i += 1) {
    const t = parseOpenMeteoTime(time[i]);
    if (!t) {
      badTimestamps += 1;
      continue;
    }
    const ms = t.getTime();
    if (ms < minMs || ms > maxMs) continue;

    hours.push({
      observedAt: t.toISOString(),
      pm25: guard(at(hourly, 'pm2_5', i), (v) => v >= 0, 'pm2_5', clamped),
    });
  }

  return { ok: true, hours, clamped, badTimestamps };
}

/* -------------------------------------------------------------------------- */
/* URL builders — one place where the parameters are stated                   */
/* -------------------------------------------------------------------------- */

/**
 * The seven hourly variables `weather_observations` stores.
 * `boundary_layer_height` is the non-obvious one: it is the dilution volume the
 * wind is stirring, and the natural next feature if the two-predictor model
 * plateaus (M6).
 */
export const WEATHER_HOURLY_VARS = [
  'temperature_2m',
  'wind_speed_10m',
  'wind_direction_10m',
  'wind_gusts_10m',
  'relative_humidity_2m',
  'precipitation',
  'boundary_layer_height',
].join(',');

export function weatherUrl(lat: number, lon: number, pastDays: number, forecastDays: number): string {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    hourly: WEATHER_HOURLY_VARS,
    past_days: String(pastDays),
    forecast_days: String(forecastDays),
    // UTC throughout: bucketing into local dates is src/lib/format.ts's job and
    // doing it in two places is how the two disagree.
    timezone: 'UTC',
    wind_speed_unit: 'ms',
  });
  return `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
}

export function airQualityUrl(lat: number, lon: number, forecastDays: number): string {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    hourly: 'pm2_5',
    forecast_days: String(forecastDays),
    timezone: 'UTC',
  });
  return `https://air-quality-api.open-meteo.com/v1/air-quality?${params.toString()}`;
}
