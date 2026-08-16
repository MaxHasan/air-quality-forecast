/**
 * ingest/weather.ts — hourly weather per location, from Open-Meteo.
 *
 * Run:
 *   npm run ingest:weather                   # normal
 *   npm run ingest:weather -- --dry-run      # fetch and parse only
 *   npm run ingest:weather -- --past-days 92 # backfill (Open-Meteo allows up to 92)
 *
 * Scheduled four times a day (see .github/workflows/ingest-weather.yml).
 * Weather changes slower than air quality and Open-Meteo is a courtesy, not a
 * contract: eight locations × four runs is 32 calls a day against a ~10k/day
 * budget.
 *
 * ---------------------------------------------------------------------------
 * Why only hours that have already happened are stored
 * ---------------------------------------------------------------------------
 * `weather_observations` is an *observation* table. Open-Meteo's `/v1/forecast`
 * endpoint serves both past and future hours from the same array, and it would
 * be one line to write all of them — which is exactly the mistake to avoid. A
 * forecast hour written here would later be read back by `rollup.ts` as though
 * it were measured, and the wind model would then be calibrated against its own
 * predictions. There is no error message for that; the model just quietly stops
 * meaning anything.
 *
 * So: `maxTime = now`, and forecast wind lives only in `predictions.inputs`,
 * where it is labelled as such.
 *
 * `past_days=2` gives a two-day trailing re-write on every run. Open-Meteo
 * revises recent hours as observations arrive, so re-upserting them is a
 * correction mechanism, not waste — and it doubles as catch-up for a skipped
 * cron. The upsert key `(location_id, observed_at, source)` makes both free.
 */

import { toLocalDate } from '../../src/lib/format';
import type { TimeZone, WeatherObservationInsert } from '../../src/lib/types';
import { loadLocations, serviceClient, upsertChunked, type LocationRecord } from '../lib/db';
import { fetchJson, sleep } from '../lib/http';
import { parseOpenMeteoWeather, weatherUrl } from '../lib/openmeteo';
import { hasFlag, intFlag, reportFatal, runJob } from '../lib/run-log';

/** Default trailing window. Open-Meteo caps `past_days` at 92. */
const DEFAULT_PAST_DAYS = 2;

/**
 * Forecast days requested. One is enough: it covers the remainder of today, and
 * everything after `now` is discarded anyway. Asking for more would only make
 * the payload bigger.
 */
const FORECAST_DAYS = 1;

/** Politeness delay between locations. */
const DELAY_MS = 200;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = hasFlag(argv, 'dry-run');
  const pastDays = Math.min(92, intFlag(argv, 'past-days', DEFAULT_PAST_DAYS));
  const now = new Date();

  await runJob('ingest-weather', { dryRun, meta: { past_days: pastDays, source: 'openmeteo' } }, async (run) => {
    const locations: LocationRecord[] = dryRun
      ? (await import('../../src/lib/stations')).LOCATIONS.map((l, i) => ({
          id: -(i + 1),
          slug: l.slug,
          timezone: l.timezone,
          lat: l.lat,
          lon: l.lon,
          name: l.name,
        }))
      : await loadLocations(serviceClient());

    const rows: WeatherObservationInsert[] = [];
    const clampedTotals: Record<string, number> = {};

    for (const [i, loc] of locations.entries()) {
      if (i > 0) await sleep(DELAY_MS);

      const scope = `openmeteo:${loc.slug}`;
      const url = weatherUrl(loc.lat, loc.lon, pastDays, FORECAST_DAYS);

      const res = await fetchJson<unknown>(url);
      if (!res.ok) {
        run.failed(scope, new Error(res.message));
        continue;
      }

      const parsed = parseOpenMeteoWeather(res.data, { maxTime: now });
      if (!parsed.ok) {
        run.failed(scope, new Error(`${parsed.reason}: ${parsed.detail}`));
        continue;
      }
      if (parsed.hours.length === 0) {
        run.failed(scope, new Error('payload contained no hours at or before now'));
        continue;
      }

      for (const [field, n] of Object.entries(parsed.clamped)) {
        clampedTotals[field] = (clampedTotals[field] ?? 0) + n;
      }

      for (const h of parsed.hours) {
        rows.push({
          location_id: loc.id,
          observed_at: h.observedAt,
          source: 'openmeteo',
          temp_c: h.tempC,
          wind_speed_ms: h.windSpeedMs,
          wind_dir_deg: h.windDirDeg,
          wind_gusts_ms: h.windGustsMs,
          rh_pct: h.rhPct,
          precip_mm: h.precipMm,
          blh_m: h.blhM,
        });
      }

      const first = parsed.hours[0];
      const last = parsed.hours[parsed.hours.length - 1];
      // Report the span in local dates: it is the bucket the rollup will use,
      // and a UTC span makes an off-by-one-day mistake invisible.
      const tz = loc.timezone as TimeZone;
      console.log(
        `  ✓ ${scope} ${parsed.hours.length}h  ${toLocalDate(first.observedAt, tz)} → ${toLocalDate(last.observedAt, tz)}` +
          `  latest wind ${last.windSpeedMs ?? '—'} m/s, dir ${last.windDirDeg ?? '—'}°`,
      );
    }

    if (Object.keys(clampedTotals).length > 0) run.note({ out_of_range_nulled: clampedTotals });
    run.note({ locations: locations.length });

    if (dryRun) {
      run.upserted(rows.length);
      console.log(`\n[dry run] would upsert ${rows.length} weather_observations row(s)`);
      return;
    }

    if (rows.length > 0) {
      run.upserted(
        await upsertChunked(
          'upserting weather_observations',
          serviceClient(),
          'weather_observations',
          rows,
          'location_id,observed_at,source',
        ),
      );
    }
  });
}

main().catch(reportFatal);
