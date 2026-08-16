import { describe, expect, it } from 'vitest';
import {
  aggregateDailyAq,
  aggregateDailyWeather,
  groupByLocalDate,
  type HourlyAq,
  type HourlyWeather,
} from '../scripts/lib/aggregate';

/**
 * The rollup is where hourly readings become the numbers the model is fit on and
 * scored against. Two mistakes are available here and neither announces itself:
 *
 *   - bucketing on the UTC date, which moves 7-8 hours of every local day into
 *     the wrong average;
 *   - a flat mean across rows, which lets the station that reports most often
 *     decide the day.
 *
 * These tests exist to make both of them loud.
 */

const aq = (observed_at: string, pm25_ugm3: number | null, station_id = 1): HourlyAq => ({
  station_id,
  observed_at,
  pm25_ugm3,
});

describe('groupByLocalDate', () => {
  it('buckets Jakarta hours on the local date, not the UTC one', () => {
    // 17:00 UTC is already tomorrow in WIB. A UTC bucket would put these two
    // hours in the same day; they belong to different days.
    const rows = [aq('2026-08-16T16:59:00Z', 10), aq('2026-08-16T17:00:00Z', 20)];
    const grouped = groupByLocalDate(rows, 'Asia/Jakarta');
    expect([...grouped.keys()].sort()).toEqual(['2026-08-16', '2026-08-17']);
  });

  it('puts Bali a day ahead of Jakarta in the 16:00-17:00 UTC window', () => {
    // The reason Bali is Asia/Makassar (UTC+8) and not Asia/Jakarta.
    const rows = [aq('2026-08-16T16:30:00Z', 10)];
    expect([...groupByLocalDate(rows, 'Asia/Jakarta').keys()]).toEqual(['2026-08-16']);
    expect([...groupByLocalDate(rows, 'Asia/Makassar').keys()]).toEqual(['2026-08-17']);
  });

  it('drops rows with an unparseable timestamp rather than mis-bucketing them', () => {
    const grouped = groupByLocalDate([aq('not-a-date', 10), aq('2026-08-16T01:00:00Z', 20)], 'Asia/Jakarta');
    expect(grouped.size).toBe(1);
    expect(grouped.get('2026-08-16')).toHaveLength(1);
  });
});

describe('aggregateDailyAq — averaging across stations', () => {
  it('averages within the hour first, then across hours', () => {
    // Two stations, same two hours: 10/20 then 30/40. Hourly means are 15 and
    // 35, so the day is 25.
    const rows = [
      aq('2026-08-16T01:00:00Z', 10, 1),
      aq('2026-08-16T01:00:00Z', 20, 2),
      aq('2026-08-16T02:00:00Z', 30, 1),
      aq('2026-08-16T02:00:00Z', 40, 2),
    ];
    const agg = aggregateDailyAq(rows)!;
    expect(agg.pm25_avg).toBe(25);
    expect(agg.hours_count).toBe(2);
    expect(agg.station_count).toBe(2);
  });

  it('does not let a more prolific station dominate the day', () => {
    // Station 1 reports both hours at 100, station 2 only the first hour at 0.
    // Hourly means: 50 and 100 -> 75.
    // A flat mean over the three rows would give 66.7, weighted by whoever
    // happened to report more often rather than by what the air did.
    const rows = [
      aq('2026-08-16T01:00:00Z', 100, 1),
      aq('2026-08-16T01:00:00Z', 0, 2),
      aq('2026-08-16T02:00:00Z', 100, 1),
    ];
    const agg = aggregateDailyAq(rows)!;
    expect(agg.pm25_avg).toBe(75);
    expect(agg.pm25_avg).not.toBeCloseTo(200 / 3, 5);
  });

  it('reports min and max of the hourly means, so min <= avg <= max holds', () => {
    const rows = [
      aq('2026-08-16T01:00:00Z', 10, 1),
      aq('2026-08-16T01:00:00Z', 30, 2),
      aq('2026-08-16T02:00:00Z', 60, 1),
    ];
    const agg = aggregateDailyAq(rows)!;
    expect(agg.pm25_min).toBe(20); // hour 1 mean
    expect(agg.pm25_max).toBe(60); // hour 2 mean
    expect(agg.pm25_min!).toBeLessThanOrEqual(agg.pm25_avg);
    expect(agg.pm25_avg).toBeLessThanOrEqual(agg.pm25_max!);
  });

  it('collapses several readings in one hour into one bucket', () => {
    const rows = [
      aq('2026-08-16T01:00:00Z', 10, 1),
      aq('2026-08-16T01:30:00Z', 30, 1),
      aq('2026-08-16T02:00:00Z', 50, 1),
    ];
    const agg = aggregateDailyAq(rows)!;
    expect(agg.hours_count).toBe(2);
    expect(agg.pm25_avg).toBe(35); // (20 + 50) / 2
  });

  it('counts distinct hours, which is the coverage guard scoring depends on', () => {
    // prediction_scores refuses to score a day below 12 hours (0002_views.sql).
    const rows = Array.from({ length: 14 }, (_, h) =>
      aq(`2026-08-16T${String(h).padStart(2, '0')}:00:00Z`, 20),
    );
    expect(aggregateDailyAq(rows)!.hours_count).toBe(14);
  });

  it('ignores nulls and negatives, and returns null when nothing usable remains', () => {
    expect(aggregateDailyAq([aq('2026-08-16T01:00:00Z', null)])).toBeNull();
    expect(aggregateDailyAq([aq('2026-08-16T01:00:00Z', -5)])).toBeNull();
    expect(aggregateDailyAq([])).toBeNull();

    const agg = aggregateDailyAq([aq('2026-08-16T01:00:00Z', null), aq('2026-08-16T02:00:00Z', 30)])!;
    expect(agg.pm25_avg).toBe(30);
    expect(agg.hours_count).toBe(1);
  });

  it('never returns NaN', () => {
    // `daily_aq.pm25_avg` is NOT NULL; a NaN would be rejected by Postgres and
    // take the whole batch with it.
    const agg = aggregateDailyAq([aq('2026-08-16T01:00:00Z', Number.NaN), aq('2026-08-16T02:00:00Z', 10)])!;
    expect(Number.isFinite(agg.pm25_avg)).toBe(true);
  });

  it('caps hours_count at 24 to satisfy the schema CHECK', () => {
    const rows = Array.from({ length: 30 }, (_, h) => aq(new Date(Date.UTC(2026, 7, 16, h)).toISOString(), 20));
    expect(aggregateDailyAq(rows)!.hours_count).toBe(24);
  });
});

const wx = (observed_at: string, over: Partial<HourlyWeather> = {}): HourlyWeather => ({
  observed_at,
  temp_c: null,
  wind_speed_ms: null,
  wind_dir_deg: null,
  rh_pct: null,
  precip_mm: null,
  blh_m: null,
  ...over,
});

describe('aggregateDailyWeather', () => {
  it('averages the predictor the model rests on', () => {
    const rows = [
      wx('2026-08-16T01:00:00Z', { wind_speed_ms: 1 }),
      wx('2026-08-16T02:00:00Z', { wind_speed_ms: 3 }),
      wx('2026-08-16T03:00:00Z', { wind_speed_ms: 5 }),
    ];
    const agg = aggregateDailyWeather(rows)!;
    expect(agg.wind_speed_avg_ms).toBe(3);
    expect(agg.wind_speed_max_ms).toBe(5);
    expect(agg.hours_count).toBe(3);
  });

  it('vector-averages wind direction across the 0/360 wrap', () => {
    // A scalar mean of 350 and 10 gives 180 — due south, the exact opposite of
    // the truth, and enough to invert the seasonal easterly/north-westerly story
    // the whole analysis rests on.
    const agg = aggregateDailyWeather([
      wx('2026-08-16T01:00:00Z', { wind_dir_deg: 350 }),
      wx('2026-08-16T02:00:00Z', { wind_dir_deg: 10 }),
    ])!;
    expect(agg.wind_dir_vector_deg!).toBeCloseTo(0, 6);
    expect(agg.wind_dir_consistency!).toBeGreaterThan(0.98);
  });

  it('reports low consistency when the wind boxed the compass', () => {
    const agg = aggregateDailyWeather([
      wx('2026-08-16T01:00:00Z', { wind_dir_deg: 0 }),
      wx('2026-08-16T02:00:00Z', { wind_dir_deg: 180 }),
    ])!;
    expect(agg.wind_dir_consistency!).toBeLessThan(1e-6);
  });

  it('sums precipitation rather than averaging it', () => {
    // mm is a per-hour total; a mean would report a rate nobody wants.
    const agg = aggregateDailyWeather([
      wx('2026-08-16T01:00:00Z', { precip_mm: 2 }),
      wx('2026-08-16T02:00:00Z', { precip_mm: 3 }),
      wx('2026-08-16T03:00:00Z', { precip_mm: 0 }),
    ])!;
    expect(agg.precip_mm_total).toBe(5);
  });

  it('keeps each field independent, so one gap costs only that field', () => {
    // The hour with no boundary-layer height must not cost us the wind average.
    const agg = aggregateDailyWeather([
      wx('2026-08-16T01:00:00Z', { wind_speed_ms: 2, blh_m: 800 }),
      wx('2026-08-16T02:00:00Z', { wind_speed_ms: 4 }),
    ])!;
    expect(agg.wind_speed_avg_ms).toBe(3);
    expect(agg.blh_avg_m).toBe(800);
    expect(agg.temp_avg_c).toBeNull();
  });

  it('deduplicates repeated hours instead of double-weighting them', () => {
    const agg = aggregateDailyWeather([
      wx('2026-08-16T01:00:00Z', { wind_speed_ms: 1 }),
      wx('2026-08-16T01:30:00Z', { wind_speed_ms: 9 }),
      wx('2026-08-16T02:00:00Z', { wind_speed_ms: 3 }),
    ])!;
    expect(agg.hours_count).toBe(2);
    expect(agg.wind_speed_avg_ms).toBe(6); // the later 01:00 row wins, then 3
  });

  it('returns null for an empty day and never NaN for a sparse one', () => {
    expect(aggregateDailyWeather([])).toBeNull();
    const agg = aggregateDailyWeather([wx('2026-08-16T01:00:00Z')])!;
    expect(agg.wind_speed_avg_ms).toBeNull();
    expect(agg.wind_dir_vector_deg).toBeNull();
    expect(agg.hours_count).toBe(1);
  });
});

describe('end-to-end bucketing', () => {
  it('splits a UTC-day of hourly rows into two Jakarta days at the right point', () => {
    // 24 hours of UTC 2026-08-16, with a distinct value per hour.
    const rows = Array.from({ length: 24 }, (_, h) =>
      aq(`2026-08-16T${String(h).padStart(2, '0')}:00:00Z`, h),
    );
    const grouped = groupByLocalDate(rows, 'Asia/Jakarta');

    // 00:00-16:00 UTC is 07:00-23:00 on the 16th WIB — 17 hours.
    // 17:00-23:00 UTC is 00:00-06:00 on the 17th WIB — 7 hours.
    const day16 = aggregateDailyAq(grouped.get('2026-08-16')!)!;
    const day17 = aggregateDailyAq(grouped.get('2026-08-17')!)!;
    expect(day16.hours_count).toBe(17);
    expect(day17.hours_count).toBe(7);
    expect(day16.pm25_avg).toBe(8); // mean of 0..16
    expect(day17.pm25_avg).toBe(20); // mean of 17..23
  });
});
