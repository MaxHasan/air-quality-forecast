/**
 * ingest/aq.ts — hourly PM2.5 ground truth, from three very different feeds.
 *
 * Run:
 *   npm run ingest:aq                 # normal: fetch, upsert, log the run
 *   npm run ingest:aq -- --dry-run    # fetch and parse only; touches no database
 *   npm run ingest:aq -- --only=airgradient   # one source (see ingest-airgradient.yml)
 *
 * Scheduled hourly at :17 (see .github/workflows/ingest-aq.yml). The
 * odd minute is deliberate — GitHub's cron queue is busiest on the hour, and a
 * job that is drift-tolerant should not also be queue-contended.
 *
 * ---------------------------------------------------------------------------
 * What each source contributes, and the trap in each
 * ---------------------------------------------------------------------------
 * WAQI (Indonesia — BMKG + KLHK):
 *   One current hour per station. `iaqi.pm25.v` is a US-EPA AQI *sub-index*, so
 *   it is inverted through src/lib/aqi.ts; both the index and the concentration
 *   are stored along with the breakpoint table used, which makes a wrong table
 *   an UPDATE rather than a re-fetch. Feeds go quiet without saying so, hence
 *   the staleness budget and the dormancy sweep at the end.
 *
 * data.gov.sg (Singapore — NEA):
 *   Five regions, and `?date=` returns the *whole day*. So each run asks for
 *   today and yesterday: that two-day trailing window is the catch-up mechanism
 *   for a skipped or drifted cron, and it costs nothing because every write is
 *   an idempotent upsert on (station_id, observed_at).
 *
 * AirGradient (Jakarta + Bali — the Nafas network's actual home):
 *   One keyless call returns every public monitor on Earth; we keep the seeded
 *   ids. The readings are RAW low-cost-sensor values that overread in humid
 *   air, so the US-EPA (Barkjohn 2021) humidity correction is applied before
 *   anything is stored — see scripts/lib/airgradient.ts for the whole story.
 *   `pm25_ugm3` gets the corrected value; `raw` retains pm02 + RH + formula id,
 *   which `npm run rederive:airgradient` uses to recompute history if the
 *   correction is revised — for about 30 days, after which retention nulls
 *   `raw` and the inputs are gone for good.
 *
 * ---------------------------------------------------------------------------
 * Failure policy
 * ---------------------------------------------------------------------------
 * One dead station must never stop the rest. Each feed is fetched and
 * parsed inside its own try, failures are recorded against the station's scope
 * and the run closes `partial`. Only a failure that is not scoped to a station
 * — no credentials, no schema, no stations at all — ends the run.
 *
 * A *stale* feed is not a failure. It is a station that is alive but behind, and
 * writing its hours-old value into the current hour would be worse than writing
 * nothing: the daily average would silently include air that has already blown
 * away. Stale feeds are counted in `meta`, not in `failures`.
 */

import { DEFAULT_AQI_TABLE_ID } from '../../src/lib/aqi';
import { addLocalDays, todayLocalDate } from '../../src/lib/format';
import { DORMANT_STATION_DAYS, STALE_FEED_HOURS } from '../../src/lib/stations';
import type { AqObservationInsert, JobName, Json, SgRegionName } from '../../src/lib/types';
import { AIRGRADIENT_WORLD_URL, parseAirGradientWorld } from '../lib/airgradient';
import { parseDataGovSgPm25 } from '../lib/datagovsg';
import { DbFailure, describeDbError, loadStations, serviceClient, upsertChunked, type StationRecord } from '../lib/db';
import { fetchJson, sleep } from '../lib/http';
import { hasFlag, reportFatal, runJob, stringFlag, type RunLog } from '../lib/run-log';
import { parseWaqiFeed } from '../lib/waqi';

/** Politeness delay between WAQI calls. The token is free; the goodwill is not. */
const WAQI_DELAY_MS = 250;

/** Newest observation seen per station this run — drives `last_seen_at`. */
type SeenMap = Map<number, string>;

function markSeen(seen: SeenMap, stationId: number, observedAt: string): void {
  const current = seen.get(stationId);
  if (!current || observedAt > current) seen.set(stationId, observedAt);
}

/* -------------------------------------------------------------------------- */
/* WAQI                                                                       */
/* -------------------------------------------------------------------------- */

async function ingestWaqi(
  run: RunLog,
  stations: readonly StationRecord[],
  token: string,
  now: Date,
  seen: SeenMap,
): Promise<AqObservationInsert[]> {
  const rows: AqObservationInsert[] = [];
  const stale: string[] = [];
  const noData: string[] = [];
  const unknownIds: string[] = [];

  for (const [i, station] of stations.entries()) {
    if (i > 0) await sleep(WAQI_DELAY_MS);

    const scope = `waqi:@${station.source_station_id}`;
    // The '@' prefix is added here, never stored: `source_station_id` holds the
    // bare uid, and some uids are legitimately negative ('-416785').
    const url = `https://api.waqi.info/feed/@${station.source_station_id}/?token=${encodeURIComponent(token)}`;

    const res = await fetchJson<unknown>(url);
    if (!res.ok) {
      run.failed(scope, new Error(res.message));
      continue;
    }

    const parsed = parseWaqiFeed(res.data, { now, staleHours: STALE_FEED_HOURS });

    if (!parsed.ok) {
      switch (parsed.reason) {
        case 'stale':
          // Alive, just behind. Record freshness so the dormancy sweep leaves
          // it alone, but write no observation.
          if (parsed.observedAt) markSeen(seen, station.id, parsed.observedAt);
          stale.push(`${scope} (${parsed.detail})`);
          console.log(`  ~ ${scope} stale — ${parsed.detail}`);
          break;
        case 'no-pm25':
          noData.push(`${scope} (${parsed.detail})`);
          console.log(`  ~ ${scope} no PM2.5 this hour — ${parsed.detail}`);
          break;
        case 'unknown-id':
          // The station has been removed upstream. Not a transient failure, and
          // not something a retry fixes: it needs `npm run discover:stations`.
          unknownIds.push(scope);
          run.failed(scope, new Error(`WAQI no longer knows this uid (${parsed.detail}). Re-run discover:stations.`));
          break;
        default:
          run.failed(scope, new Error(`${parsed.reason}: ${parsed.detail}`));
      }
      continue;
    }

    rows.push({
      station_id: station.id,
      observed_at: parsed.observedAt,
      pm25_ugm3: parsed.pm25,
      pm25_aqi_us: parsed.aqi,
      aqi_table: parsed.aqiTable,
      raw: parsed.raw,
    });
    markSeen(seen, station.id, parsed.observedAt);
    console.log(
      `  ✓ ${scope} ${station.name} — AQI ${parsed.aqi} → ${parsed.pm25} µg/m³ ` +
        `@ ${parsed.observedAt} (${parsed.ageHours.toFixed(1)}h old)`,
    );
  }

  run.note({
    waqi_stations: stations.length,
    waqi_rows: rows.length,
    waqi_stale: stale.length,
    waqi_no_pm25: noData.length,
    ...(stale.length ? { waqi_stale_detail: stale } : {}),
    ...(unknownIds.length ? { waqi_unknown_ids: unknownIds } : {}),
  });

  return rows;
}

/* -------------------------------------------------------------------------- */
/* data.gov.sg                                                                */
/* -------------------------------------------------------------------------- */

async function ingestDataGovSg(
  run: RunLog,
  stations: readonly StationRecord[],
  now: Date,
  seen: SeenMap,
): Promise<AqObservationInsert[]> {
  // Region name -> station id. `source_station_id` is the region name itself.
  const byRegion = new Map<string, StationRecord>();
  for (const s of stations) byRegion.set(s.source_station_id.toLowerCase(), s);

  // Today and yesterday *in Singapore*, not in UTC: at 23:30 UTC the local date
  // is already tomorrow, and asking for the UTC date would skip the current day
  // entirely for the first eight hours of it.
  const today = todayLocalDate('Asia/Singapore', now);
  if (!today) throw new DbFailure('could not determine the current date in Asia/Singapore');
  const yesterday = addLocalDays(today, -1);
  const dates = [yesterday, today].filter((d): d is string => d !== null);

  const rows: AqObservationInsert[] = [];
  const totals = { badTimestamp: 0, badValue: 0, superseded: 0, future: 0 };

  for (const date of dates) {
    const scope = `datagovsg:${date}`;
    const res = await fetchJson<unknown>(`https://api-open.data.gov.sg/v2/real-time/api/pm25?date=${date}`);

    if (!res.ok) {
      // A 404 on *yesterday* during the first hours of a new day is normal-ish
      // and never worth failing over; a 404 on today is worth surfacing.
      if (res.status === 404 && date !== today) {
        console.log(`  ~ ${scope} no data published for that date`);
        continue;
      }
      run.failed(scope, new Error(res.message));
      continue;
    }

    const parsed = parseDataGovSgPm25(res.data, { maxTime: now });
    if (!parsed.ok) {
      run.failed(scope, new Error(`${parsed.reason}: ${parsed.detail}`));
      continue;
    }

    totals.badTimestamp += parsed.skipped.badTimestamp;
    totals.badValue += parsed.skipped.badValue;
    totals.superseded += parsed.skipped.superseded;
    totals.future += parsed.skipped.future;

    let matched = 0;
    const unmapped = new Set<SgRegionName>();
    for (const reading of parsed.readings) {
      const station = byRegion.get(reading.region);
      if (!station) {
        unmapped.add(reading.region);
        continue;
      }
      rows.push({
        station_id: station.id,
        observed_at: reading.observedAt,
        pm25_ugm3: reading.pm25,
        // Native concentrations: no sub-index was published and no inversion
        // happened, so both AQI columns stay null rather than being back-computed.
        pm25_aqi_us: null,
        aqi_table: null,
        // The whole day's payload would be stored five times over per hour.
        // A compact provenance record is enough to reconstruct the reading.
        raw: {
          source: 'datagovsg',
          region: reading.region,
          pm25_ugm3: reading.pm25,
          updated_at: reading.updatedAt,
        } as Json,
      });
      markSeen(seen, station.id, reading.observedAt);
      matched += 1;
    }

    if (unmapped.size > 0) {
      // Not fatal: NEA adding a sixth region should be visible, not fatal.
      console.log(`  ! ${scope} regions with no seeded station: ${[...unmapped].join(', ')}`);
    }
    console.log(`  ✓ ${scope} ${matched} reading(s) across ${byRegion.size} region(s)`);
  }

  run.note({
    sg_dates: dates,
    sg_rows: rows.length,
    sg_skipped_bad_value: totals.badValue,
    sg_skipped_superseded: totals.superseded,
    sg_skipped_future: totals.future,
    sg_skipped_bad_timestamp: totals.badTimestamp,
  });

  return rows;
}

/* -------------------------------------------------------------------------- */
/* AirGradient                                                                */
/* -------------------------------------------------------------------------- */

async function ingestAirGradient(
  run: RunLog,
  stations: readonly StationRecord[],
  now: Date,
  seen: SeenMap,
): Promise<AqObservationInsert[]> {
  const byId = new Map(stations.map((s) => [s.source_station_id, s]));

  const res = await fetchJson<unknown>(AIRGRADIENT_WORLD_URL);
  if (!res.ok) {
    // One endpoint serves every AirGradient station, so one failure scope
    // covers them all — that is accurate, not lazy: there is nothing to retry
    // per-station.
    run.failed('airgradient:world', new Error(res.message));
    return [];
  }

  const parsed = parseAirGradientWorld(res.data, {
    now,
    staleHours: STALE_FEED_HOURS,
    wanted: new Set(byId.keys()),
  });
  if (!parsed.ok) {
    run.failed('airgradient:world', new Error(`${parsed.reason}: ${parsed.detail}`));
    return [];
  }

  const rows: AqObservationInsert[] = [];
  for (const reading of parsed.readings) {
    const station = byId.get(reading.locationId);
    if (!station) continue;
    rows.push({
      station_id: station.id,
      observed_at: reading.observedAt,
      pm25_ugm3: reading.pm25Corrected,
      // Corrected concentration, not an index: no inversion happened, so the
      // AQI columns stay null exactly as they do for data.gov.sg.
      pm25_aqi_us: null,
      aqi_table: null,
      raw: reading.raw,
    });
    markSeen(seen, station.id, reading.observedAt);
    const rawPm = (reading.raw as { pm02_raw?: number }).pm02_raw;
    console.log(
      `  ✓ airgradient:${reading.locationId} ${station.name} — raw ${rawPm} → ${reading.pm25Corrected} µg/m³ (EPA-corrected) @ ${reading.observedAt}`,
    );
  }

  for (const skip of parsed.skipped) {
    const station = byId.get(skip.locationId);
    console.log(`  ~ airgradient:${skip.locationId} ${station?.name ?? ''} ${skip.reason} — ${skip.detail}`);
  }
  if (parsed.missing.length > 0) {
    // A seeded id absent from the world payload is how an AirGradient station
    // dies: it just stops appearing. The dormancy sweep retires it after
    // DORMANT_STATION_DAYS; this note is the early warning.
    console.log(`  ! airgradient ids not in world payload: ${parsed.missing.join(', ')}`);
  }

  run.note({
    airgradient_stations: stations.length,
    airgradient_rows: rows.length,
    airgradient_skipped: parsed.skipped.length,
    ...(parsed.skipped.length ? { airgradient_skip_detail: parsed.skipped.map((s) => `${s.locationId}:${s.reason}`) } : {}),
    ...(parsed.missing.length ? { airgradient_missing: parsed.missing } : {}),
  });

  return rows;
}

/* -------------------------------------------------------------------------- */
/* Station bookkeeping                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Advance `last_seen_at`, then retire anything that has gone quiet.
 *
 * The retirement rule uses `created_at` as the fallback clock so a station
 * seeded five minutes ago, with `last_seen_at` still null, is not immediately
 * deactivated for the crime of never having been polled.
 *
 * Deactivation is reversible by hand and is not the same as deletion: the
 * station's history stays in `aq_observations` and keeps contributing to
 * historical rollups.
 */
async function updateStationFreshness(
  run: RunLog,
  db: ReturnType<typeof serviceClient>,
  stations: readonly StationRecord[],
  seen: SeenMap,
  now: Date,
): Promise<void> {
  for (const station of stations) {
    const newest = seen.get(station.id);
    if (!newest) continue;
    // Never move the marker backwards — a catch-up run re-reading yesterday
    // must not make a station look staler than it is.
    if (station.last_seen_at && station.last_seen_at >= newest) continue;

    const { error } = await db
      .from('stations')
      .update({ last_seen_at: newest } as never)
      .eq('id', station.id);
    if (error) run.failed(`stations.last_seen_at:${station.id}`, new Error(describeDbError('updating last_seen_at', error)));
  }

  const cutoff = new Date(now.getTime() - DORMANT_STATION_DAYS * 86_400_000).toISOString();
  const dormant = stations.filter((s) => {
    const marker = seen.get(s.id) ?? s.last_seen_at ?? s.created_at;
    return marker < cutoff;
  });

  if (dormant.length === 0) return;

  const { error } = await db
    .from('stations')
    .update({ is_active: false } as never)
    .in('id', dormant.map((s) => s.id));

  if (error) {
    run.failed('stations.deactivate', new Error(describeDbError('deactivating dormant stations', error)));
    return;
  }

  const names = dormant.map((s) => `${s.source}:${s.source_station_id}`);
  run.note({ deactivated: names });
  console.log(
    `  ! deactivated ${dormant.length} station(s) unseen for ${DORMANT_STATION_DAYS}d: ${names.join(', ')}\n` +
      '    Run `npm run discover:stations` to find replacements.',
  );
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = hasFlag(argv, 'dry-run');
  // `--only=airgradient` lets the sub-hourly workflow poll just that source
  // without re-fetching WAQI and data.gov.sg twelve extra times a day (and
  // without spending WAQI goodwill on data that only changes hourly).
  const only = stringFlag(argv, 'only', null);
  const now = new Date();

  // A distinct job name for the AirGradient-only poll, because the PWA footer
  // scopes its failure streak to the most recent job's own history so that a
  // healthy job cannot mask a failing one. This job runs four times an hour and
  // would otherwise almost always be the newest run, resetting the streak and
  // hiding a WAQI outage behind a green footer.
  const jobName: JobName = only === 'airgradient' ? 'ingest-airgradient' : 'ingest-aq';

  await runJob(jobName, { dryRun, meta: { stale_feed_hours: STALE_FEED_HOURS, aqi_table: DEFAULT_AQI_TABLE_ID, ...(only ? { only } : {}) } }, async (run) => {
    const token = process.env.WAQI_TOKEN?.trim();

    /* -- which stations ---------------------------------------------------- */
    let stations: StationRecord[];
    if (dryRun) {
      // No database, so fall back to the compile-time mirror of the seed. Ids
      // are synthetic and never leave this process.
      const { ALL_STATIONS } = await import('../../src/lib/stations');
      stations = ALL_STATIONS.map((s, i) => ({
        id: -(i + 1),
        location_id: -1,
        source: s.source,
        source_station_id: s.sourceStationId,
        name: s.name,
        is_active: true,
        last_seen_at: null,
        created_at: now.toISOString(),
      }));
      console.log(`[ingest-aq] dry run over ${stations.length} seeded station(s) from src/lib/stations.ts`);
    } else {
      stations = await loadStations(serviceClient(), true);
    }

    const wants = (source: string): boolean => only === null || only === source;
    if (only !== null && !['waqi', 'datagovsg', 'airgradient'].includes(only)) {
      throw new DbFailure(`--only=${only} is not a known source (waqi | datagovsg | airgradient)`);
    }

    const waqiStations = wants('waqi') ? stations.filter((s) => s.source === 'waqi') : [];
    const sgStations = wants('datagovsg') ? stations.filter((s) => s.source === 'datagovsg') : [];
    const agStations = wants('airgradient') ? stations.filter((s) => s.source === 'airgradient') : [];
    const seen: SeenMap = new Map();
    if (only) console.log(`[${jobName}] --only=${only}`);

    /* -- fetch ------------------------------------------------------------- */
    let waqiRows: AqObservationInsert[] = [];
    if (waqiStations.length > 0) {
      // Checked here rather than trusting the earlier `--only` guard: the token
      // is required exactly when there is a WAQI station to fetch, and stating
      // that at the call site keeps the guarantee local. Relying on the flag
      // logic 40 lines up would silently break the day a fourth source joins
      // the `--only` whitelist, sending `?token=undefined` to every station and
      // reporting the resulting 401s against the stations rather than the
      // missing credential.
      if (!token) {
        throw new DbFailure(
          'Missing WAQI_TOKEN, but this run has WAQI stations to fetch.\n' +
            '  Locally:  add it to .env.local (see .env.example).\n' +
            '  In CI:    set it as the repository secret WAQI_TOKEN.\n' +
            '  Request one at https://aqicn.org/data-platform/token/\n' +
            '  Or restrict the run: --only=airgradient / --only=datagovsg',
        );
      }
      console.log(`WAQI — ${waqiStations.length} station(s)`);
      waqiRows = await ingestWaqi(run, waqiStations, token, now, seen);
    }

    let sgRows: AqObservationInsert[] = [];
    if (sgStations.length > 0) {
      console.log(`data.gov.sg — ${sgStations.length} region(s)`);
      sgRows = await ingestDataGovSg(run, sgStations, now, seen);
    }

    let agRows: AqObservationInsert[] = [];
    if (agStations.length > 0) {
      console.log(`AirGradient — ${agStations.length} station(s)`);
      agRows = await ingestAirGradient(run, agStations, now, seen);
    }

    const rows = [...waqiRows, ...sgRows, ...agRows];

    /* -- persist ----------------------------------------------------------- */
    if (dryRun) {
      run.upserted(rows.length);
      console.log(`\n[dry run] would upsert ${rows.length} aq_observations row(s):`);
      for (const r of rows.slice(0, 12)) {
        console.log(`    station=${r.station_id} ${r.observed_at} pm25=${r.pm25_ugm3} aqi=${r.pm25_aqi_us ?? '—'}`);
      }
      if (rows.length > 12) console.log(`    … and ${rows.length - 12} more`);
      return;
    }

    const db = serviceClient();
    if (rows.length > 0) {
      run.upserted(await upsertChunked('upserting aq_observations', db, 'aq_observations', rows, 'station_id,observed_at'));
    }
    // Only sweep the sources this run actually polled: an --only=airgradient run
    // has no evidence about WAQI's stations, and judging them on evidence it
    // never gathered would retire live feeds for not answering a question
    // nobody asked them.
    const polled = stations.filter((s) => wants(s.source));
    await updateStationFreshness(run, db, polled, seen, now);
  });
}

main().catch(reportFatal);
