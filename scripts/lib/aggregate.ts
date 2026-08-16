/**
 * aggregate.ts — hourly rows to one daily rollup row. Pure.
 *
 * `daily_aq` and `daily_weather` are the model's training data and the app's
 * scoring truth, so how the average is taken is not an implementation detail.
 *
 * ---------------------------------------------------------------------------
 * Why the PM2.5 average is computed in two stages
 * ---------------------------------------------------------------------------
 * A location can have several stations (Jakarta has two) and they do not report
 * the same hours. A flat mean over every row would weight each *row* equally, so:
 *
 *   - a station that reports 24 hours and one that reports 6 would let the
 *     first dominate the day, even where both were present;
 *   - a station sitting beside a main road would pull the average up simply by
 *     being more reliable than its quieter neighbour.
 *
 * Instead: mean across stations *within each local hour*, then mean across the
 * hours. Every hour that has data counts once, whoever measured it. `pm25_min`
 * and `pm25_max` are the extremes of those hourly means, so all three numbers
 * describe the same quantity and "min ≤ avg ≤ max" holds by construction.
 *
 * `hours_count` is the number of distinct local hours contributing — the
 * coverage guard that `prediction_scores` uses to refuse to score a day built
 * from three hours of data (0002_views.sql, `hours_count >= 12`).
 *
 * ---------------------------------------------------------------------------
 * Why wind direction is not averaged the same way
 * ---------------------------------------------------------------------------
 * It is a circular quantity: the arithmetic mean of 350° and 10° is 180°, the
 * exact opposite of the truth. `circularMeanDegrees` (src/lib/format.ts) does it
 * properly and also returns a consistency figure, so the UI can tell "steady
 * easterly all day" from "boxed the compass, the mean means nothing".
 *
 * Precipitation is summed, not averaged — millimetres are a per-hour total, and
 * a daily *mean* rainfall in mm/h is a number nobody wants.
 */

import { circularMeanDegrees, toLocalDate } from '../../src/lib/format';
import type {
  DailyAqInsert,
  DailyWeatherInsert,
  IsoTimestamp,
  LocalDate,
  TimeZone,
  WeatherSource,
} from '../../src/lib/types';

/** One hourly PM2.5 row, as read back from `aq_observations`. */
export interface HourlyAq {
  station_id: number;
  observed_at: IsoTimestamp;
  pm25_ugm3: number | null;
}

/** One hourly weather row, as read back from `weather_observations`. */
export interface HourlyWeather {
  observed_at: IsoTimestamp;
  temp_c: number | null;
  wind_speed_ms: number | null;
  wind_dir_deg: number | null;
  rh_pct: number | null;
  precip_mm: number | null;
  blh_m: number | null;
}

/** Aggregated PM2.5 for one local day, before the location id is attached. */
export type DailyAqAggregate = Omit<DailyAqInsert, 'location_id' | 'local_date' | 'computed_at'>;

/** Aggregated weather for one local day. */
export type DailyWeatherAggregate = Omit<DailyWeatherInsert, 'location_id' | 'local_date' | 'source' | 'computed_at'>;

const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Finite numbers only — `null` in, nothing out. Never produces NaN. */
function usable(values: readonly (number | null | undefined)[]): number[] {
  const out: number[] = [];
  for (const v of values) if (typeof v === 'number' && Number.isFinite(v)) out.push(v);
  return out;
}

/**
 * Group rows by the local date they belong to, in `tz`.
 *
 * This is the step that must never be done on the UTC date: all three covered
 * zones are ahead of UTC, so the last 7–8 hours of every local day carry the
 * *next* UTC date and would land in the wrong bucket.
 */
export function groupByLocalDate<T extends { observed_at: IsoTimestamp }>(
  rows: readonly T[],
  tz: TimeZone,
): Map<LocalDate, T[]> {
  const out = new Map<LocalDate, T[]>();
  for (const row of rows) {
    const date = toLocalDate(row.observed_at, tz);
    if (!date) continue; // unparseable timestamp: drop rather than mis-bucket
    const bucket = out.get(date);
    if (bucket) bucket.push(row);
    else out.set(date, [row]);
  }
  return out;
}

/**
 * Collapse one local day's PM2.5 rows into a rollup.
 *
 * Returns `null` when the day has no usable concentration at all — the caller
 * then writes nothing, because `daily_aq.pm25_avg` is NOT NULL and a row
 * asserting "the average was 0" would be a lie that scores predictions.
 */
export function aggregateDailyAq(rows: readonly HourlyAq[]): DailyAqAggregate | null {
  // absolute hour index -> the values every station reported in that hour
  const byHour = new Map<string, number[]>();
  const stations = new Set<number>();

  for (const row of rows) {
    if (typeof row.pm25_ugm3 !== 'number' || !Number.isFinite(row.pm25_ugm3) || row.pm25_ugm3 < 0) continue;
    const t = new Date(row.observed_at).getTime();
    if (!Number.isFinite(t)) continue;
    // Keyed on the absolute UTC hour rather than the local hour-of-day: two
    // stations reporting the same hour must meet in one bucket, and since every
    // covered zone is a whole number of hours from UTC, the local hour and the
    // UTC hour partition the day identically.
    const hourKey = String(Math.floor(t / 3_600_000));
    const bucket = byHour.get(hourKey);
    if (bucket) bucket.push(row.pm25_ugm3);
    else byHour.set(hourKey, [row.pm25_ugm3]);
    stations.add(row.station_id);
  }

  if (byHour.size === 0) return null;

  const hourlyMeans = [...byHour.values()].map(mean);

  return {
    pm25_avg: mean(hourlyMeans),
    pm25_min: Math.min(...hourlyMeans),
    pm25_max: Math.max(...hourlyMeans),
    // A local day has at most 24 distinct hours; the cap defends the schema's
    // `between 1 and 24` CHECK against a caller passing a wider window.
    hours_count: Math.min(24, byHour.size),
    station_count: Math.max(1, stations.size),
  };
}

/**
 * Collapse one local day's weather rows into a rollup.
 *
 * Every field is independently nullable: an hour missing `blh_m` should not
 * cost us the wind average, which is the one predictor the model cannot do
 * without. Returns `null` only when there are no usable hours at all.
 */
export function aggregateDailyWeather(rows: readonly HourlyWeather[]): DailyWeatherAggregate | null {
  // One row per hour. `weather_observations` is keyed on
  // (location_id, observed_at, source) so duplicates should not exist, but a
  // caller mixing sources would produce them and silently double-weight an hour.
  const byHour = new Map<string, HourlyWeather>();
  for (const row of rows) {
    const t = new Date(row.observed_at).getTime();
    if (!Number.isFinite(t)) continue;
    byHour.set(String(Math.floor(t / 3_600_000)), row);
  }
  if (byHour.size === 0) return null;

  const hours = [...byHour.values()];
  const temps = usable(hours.map((h) => h.temp_c));
  const winds = usable(hours.map((h) => h.wind_speed_ms));
  const rh = usable(hours.map((h) => h.rh_pct));
  const precip = usable(hours.map((h) => h.precip_mm));
  const blh = usable(hours.map((h) => h.blh_m));
  const dir = circularMeanDegrees(hours.map((h) => h.wind_dir_deg));

  return {
    temp_avg_c: temps.length ? mean(temps) : null,
    temp_min_c: temps.length ? Math.min(...temps) : null,
    temp_max_c: temps.length ? Math.max(...temps) : null,
    wind_speed_avg_ms: winds.length ? mean(winds) : null,
    wind_speed_max_ms: winds.length ? Math.max(...winds) : null,
    wind_dir_vector_deg: dir ? dir.mean : null,
    wind_dir_consistency: dir ? dir.consistency : null,
    rh_avg_pct: rh.length ? mean(rh) : null,
    // Summed: mm is a per-hour total, so the daily figure is the day's rainfall.
    precip_mm_total: precip.length ? precip.reduce((a, b) => a + b, 0) : null,
    blh_avg_m: blh.length ? mean(blh) : null,
    hours_count: Math.min(24, byHour.size),
  };
}

/** Attach identity to an aggregate to make the row `rollup.ts` upserts. */
export function toDailyAqRow(
  locationId: number,
  localDate: LocalDate,
  agg: DailyAqAggregate,
): DailyAqInsert {
  return { location_id: locationId, local_date: localDate, ...agg };
}

export function toDailyWeatherRow(
  locationId: number,
  localDate: LocalDate,
  source: WeatherSource,
  agg: DailyWeatherAggregate,
): DailyWeatherInsert {
  return { location_id: locationId, local_date: localDate, source, ...agg };
}
