/**
 * rollup.ts — hourly observations to daily, per location, on the LOCAL date.
 *
 * Run:
 *   npm run rollup                  # trailing 3 local days (the cron default)
 *   npm run rollup -- --days 92     # after a backfill
 *   npm run rollup -- --dry-run     # compute and print, write nothing
 *
 * `daily_aq` and `daily_weather` are tables, not views, and this is the only
 * thing that writes them. Two consequences worth stating plainly:
 *
 *   - **Scoring needs no job.** `prediction_scores` (0002_views.sql) joins
 *     predictions to `daily_aq` on the target date, so the moment this script
 *     lands yesterday's actual, every prediction that named that date becomes
 *     scored. That is why the pipeline has an ingest step and a predict step but
 *     no scoring step.
 *   - **Recomputation must be safe.** The trailing window deliberately overlaps
 *     itself: today's average is partial and will be recomputed by every run for
 *     the next three days, as late-arriving hours land. Upserting on the primary
 *     key makes that a correction rather than a duplicate.
 *
 * ---------------------------------------------------------------------------
 * The local-date discipline
 * ---------------------------------------------------------------------------
 * Every zone here is ahead of UTC (WIB +7, WITA/SGT +8). Bucketing on the UTC
 * date would move the last seven hours of each Jakarta day into the following
 * day's average — a ~30% corruption of the exact quantity the wind model is fit
 * on, with no symptom other than a model that does not work.
 *
 * So the window is built with `localDayUtcRange` from src/lib/format.ts and rows
 * are grouped with `toLocalDate` from the same file, rather than with anything
 * clever in SQL. One implementation, shared with the frontend, tested in
 * tests/format.test.ts.
 */

import { addLocalDays, localDayUtcRange, todayLocalDate } from '../src/lib/format';
import type { DailyAqInsert, DailyWeatherInsert, LocalDate, TimeZone } from '../src/lib/types';
import {
  aggregateDailyAq,
  aggregateDailyWeather,
  groupByLocalDate,
  toDailyAqRow,
  toDailyWeatherRow,
  type HourlyAq,
  type HourlyWeather,
} from './lib/aggregate';
import {
  DbFailure,
  loadLocations,
  loadStations,
  selectAllPages,
  serviceClient,
  upsertChunked,
  type LocationRecord,
} from './lib/db';
import { hasFlag, intFlag, reportFatal, runJob, type RunLog } from './lib/run-log';

/** Matches the 2-day catch-up window of the ingestion jobs, plus one for slack. */
const DEFAULT_DAYS = 3;

/** The local dates to recompute: today back through `days - 1`. */
function targetDates(tz: TimeZone, days: number, now: Date): LocalDate[] {
  const today = todayLocalDate(tz, now);
  if (!today) throw new DbFailure(`could not determine today's date in ${tz}`);
  const out: LocalDate[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = addLocalDays(today, -i);
    if (d) out.push(d);
  }
  return out;
}

/**
 * Recompute one location.
 *
 * Reads the whole window in one paginated pass and buckets it in memory rather
 * than issuing a query per day: 92 days × 8 locations × 2 tables would be 1472
 * round-trips against a free-tier project, and PostgREST's per-request overhead
 * dwarfs the work.
 */
async function rollupLocation(
  run: RunLog,
  loc: LocationRecord,
  stationIds: readonly number[],
  dates: readonly LocalDate[],
  dryRun: boolean,
): Promise<{ aq: DailyAqInsert[]; weather: DailyWeatherInsert[] }> {
  const tz = loc.timezone as TimeZone;

  const first = localDayUtcRange(dates[0], tz);
  const last = localDayUtcRange(dates[dates.length - 1], tz);
  if (!first || !last) throw new DbFailure(`bad local date range for ${loc.slug}`);

  const db = serviceClient();

  /* -- PM2.5 -------------------------------------------------------------- */
  let aqRows: DailyAqInsert[] = [];
  if (stationIds.length === 0) {
    console.log(`  ~ ${loc.slug}: no stations mapped — skipping daily_aq`);
  } else {
    const hourly = await selectAllPages<HourlyAq>(`reading aq_observations for ${loc.slug}`, (from, to) =>
      db
        .from('aq_observations')
        .select('station_id, observed_at, pm25_ugm3')
        .in('station_id', stationIds as number[])
        .gte('observed_at', first.startIso)
        // Half-open: the end instant belongs to the *next* local day.
        .lt('observed_at', last.endIso)
        .order('observed_at')
        .range(from, to)
        .returns<HourlyAq[]>(),
    );

    const byDate = groupByLocalDate(hourly, tz);
    for (const date of dates) {
      const rows = byDate.get(date);
      if (!rows || rows.length === 0) continue;
      const agg = aggregateDailyAq(rows);
      if (!agg) continue;
      aqRows.push(toDailyAqRow(loc.id, date, agg));
    }

    // Sorted so dry-run output and CI logs read chronologically.
    aqRows = aqRows.sort((a, b) => a.local_date.localeCompare(b.local_date));
  }

  /* -- weather ------------------------------------------------------------ */
  const weatherHourly = await selectAllPages<HourlyWeather>(`reading weather_observations for ${loc.slug}`, (from, to) =>
    db
      .from('weather_observations')
      .select('observed_at, temp_c, wind_speed_ms, wind_dir_deg, rh_pct, precip_mm, blh_m')
      .eq('location_id', loc.id)
      // One source per rollup row — mixing providers into one average would
      // silently blend two different instruments' scales.
      .eq('source', 'openmeteo')
      .gte('observed_at', first.startIso)
      .lt('observed_at', last.endIso)
      .order('observed_at')
      .range(from, to)
      .returns<HourlyWeather[]>(),
  );

  const weatherByDate = groupByLocalDate(weatherHourly, tz);
  const weatherRows: DailyWeatherInsert[] = [];
  for (const date of dates) {
    const rows = weatherByDate.get(date);
    if (!rows || rows.length === 0) continue;
    const agg = aggregateDailyWeather(rows);
    if (!agg) continue;
    weatherRows.push(toDailyWeatherRow(loc.id, date, 'openmeteo', agg));
  }

  const latestAq = aqRows[aqRows.length - 1];
  const latestWx = weatherRows[weatherRows.length - 1];
  console.log(
    `  ✓ ${loc.slug.padEnd(16)} daily_aq ${String(aqRows.length).padStart(3)}  daily_weather ${String(weatherRows.length).padStart(3)}` +
      (latestAq ? `   latest ${latestAq.local_date}: ${latestAq.pm25_avg.toFixed(1)} µg/m³ (${latestAq.hours_count}h, ${latestAq.station_count} stn)` : '   no PM2.5') +
      (latestWx?.wind_speed_avg_ms != null ? `, wind ${latestWx.wind_speed_avg_ms.toFixed(2)} m/s` : ''),
  );

  if (dryRun) run.note({ [`${loc.slug}_daily_aq`]: aqRows.length, [`${loc.slug}_daily_weather`]: weatherRows.length });

  return { aq: aqRows, weather: weatherRows };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = hasFlag(argv, 'dry-run');
  const days = intFlag(argv, 'days', DEFAULT_DAYS);
  const now = new Date();

  await runJob('rollup', { dryRun, meta: { days } }, async (run) => {
    // Unlike ingestion, the rollup has no meaningful offline mode: it reads what
    // the database holds. `--dry-run` therefore still reads, but writes nothing.
    const db = serviceClient();
    const locations = await loadLocations(db);
    // `activeOnly: false` — a station deactivated last week still measured real
    // air the week before, and dropping its history would rewrite the past.
    const stations = await loadStations(db, false);

    const stationsByLocation = new Map<number, number[]>();
    for (const s of stations) {
      const list = stationsByLocation.get(s.location_id);
      if (list) list.push(s.id);
      else stationsByLocation.set(s.location_id, [s.id]);
    }

    const allAq: DailyAqInsert[] = [];
    const allWeather: DailyWeatherInsert[] = [];

    for (const loc of locations) {
      const dates = targetDates(loc.timezone as TimeZone, days, now);
      try {
        const { aq, weather } = await rollupLocation(run, loc, stationsByLocation.get(loc.id) ?? [], dates, dryRun);
        allAq.push(...aq);
        allWeather.push(...weather);
      } catch (err) {
        // One location's rollup failing is scoped: the others are independent
        // and their days should still land.
        run.failed(`rollup:${loc.slug}`, err);
      }
    }

    run.note({ daily_aq_rows: allAq.length, daily_weather_rows: allWeather.length, locations: locations.length });

    if (dryRun) {
      run.upserted(allAq.length + allWeather.length);
      console.log(`\n[dry run] would upsert ${allAq.length} daily_aq + ${allWeather.length} daily_weather row(s)`);
      return;
    }

    if (allAq.length > 0) {
      run.upserted(await upsertChunked('upserting daily_aq', db, 'daily_aq', allAq, 'location_id,local_date'));
    }
    if (allWeather.length > 0) {
      run.upserted(
        await upsertChunked('upserting daily_weather', db, 'daily_weather', allWeather, 'location_id,local_date,source'),
      );
    }
  });
}

main().catch(reportFatal);
