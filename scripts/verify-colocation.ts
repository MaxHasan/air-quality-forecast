/**
 * verify-colocation.ts — measure the AirGradient correction against a
 * reference instrument, on demand.
 *
 * Run:  npm run verify:colocation
 *
 * The accident of geography this exploits: AirGradient location 199980
 * ("BMKG 1") sits at BMKG headquarters in Kemayoran, a few hundred meters from
 * the beta-attenuation monitor behind WAQI uid 8294 — the same reference
 * station the wind model's 2022-2023 training weather came from. One is a
 * $100-class optical sensor, the other is the closest thing Jakarta has to
 * ground truth, and they breathe the same air.
 *
 * So this script asks one question: after the EPA (Barkjohn 2021) humidity
 * correction, how far is the cheap sensor from the reference *right now*?
 *
 * TWO MODES, and the default is the weaker one:
 *
 *   (default)     One spot comparison against the APIs right now. Needs no
 *                 database, but divides a BAM hourly average by an AirGradient
 *                 instant taken up to an hour apart, so the headline percentage
 *                 carries far more error than a single figure suggests. Good
 *                 for "is the pipeline sane", not for "how good is the
 *                 correction".
 *
 *   --hours N     Compares stored hourly means: both series are averaged within
 *                 each UTC hour from `aq_observations`, and only hours where
 *                 BOTH stations reported are scored. This is the like-for-like
 *                 comparison — an hourly mean against an hourly mean — over N
 *                 hours instead of one lucky instant. Use this before making
 *                 any claim about the quality of the correction.
 *
 * Interpreting the answer honestly:
 *   - Expect the correction to NARROW the gap, not close it (raw ~52 vs BAM
 *     ~29 on discovery day). A corrected value persistently on the wrong side
 *     of the raw one, or a gap that grows after correction, means the formula
 *     is being misapplied and ingestion should be treated as suspect.
 *   - Exit code 1 only for "could not compare" (a feed failed, or no overlapping
 *     hours exist yet). Disagreement is a *finding*, not a failure — the whole
 *     point is to see it.
 */

import { STALE_FEED_HOURS } from '../src/lib/stations';
import { AIRGRADIENT_WORLD_URL, parseAirGradientWorld } from './lib/airgradient';
import { DbFailure, describeDbError, serviceClient } from './lib/db';
import { fetchJson } from './lib/http';
import { intFlag } from './lib/run-log';
import { parseWaqiFeed } from './lib/waqi';

const WAQI_KEMAYORAN_UID = '8294';
const AIRGRADIENT_BMKG_ID = '199980';

interface ObsRow {
  station_id: number;
  observed_at: string;
  pm25_ugm3: number | null;
  raw: { source?: unknown; pm02_raw?: unknown } | null;
}

/** Mean of every sample a station contributed to each UTC hour. */
function hourlyMeans(rows: readonly ObsRow[], pick: (r: ObsRow) => number | null): Map<string, number> {
  const buckets = new Map<string, number[]>();
  for (const r of rows) {
    const v = pick(r);
    if (v === null || !Number.isFinite(v)) continue;
    const t = new Date(r.observed_at).getTime();
    if (!Number.isFinite(t)) continue;
    const key = String(Math.floor(t / 3_600_000));
    const bucket = buckets.get(key);
    if (bucket) bucket.push(v);
    else buckets.set(key, [v]);
  }
  const out = new Map<string, number>();
  for (const [k, vs] of buckets) out.set(k, vs.reduce((a, b) => a + b, 0) / vs.length);
  return out;
}

/**
 * The like-for-like comparison: hourly mean against hourly mean, over N hours.
 *
 * Only hours where both stations reported are scored. An hour the BAM missed is
 * not evidence about the sensor, and pairing it with a neighbouring hour would
 * manufacture a disagreement that never happened.
 */
async function compareStoredHours(hours: number): Promise<void> {
  const db = serviceClient();
  const since = new Date(Date.now() - hours * 3_600_000).toISOString();

  const { data: stations, error: stationErr } = await db
    .from('stations')
    .select('id, source, source_station_id, name')
    .in('source_station_id', [WAQI_KEMAYORAN_UID, AIRGRADIENT_BMKG_ID])
    .returns<{ id: number; source: string; source_station_id: string; name: string }[]>();
  if (stationErr) throw new DbFailure(describeDbError('reading stations', stationErr));

  const bam = stations?.find((s) => s.source === 'waqi' && s.source_station_id === WAQI_KEMAYORAN_UID);
  const ag = stations?.find((s) => s.source === 'airgradient' && s.source_station_id === AIRGRADIENT_BMKG_ID);
  if (!bam || !ag) {
    throw new DbFailure(
      'Both co-located stations must be seeded for --hours mode ' +
        `(BAM found: ${Boolean(bam)}, AirGradient found: ${Boolean(ag)}). Apply 0006_airgradient.sql first.`,
    );
  }

  const { data, error } = await db
    .from('aq_observations')
    .select('station_id, observed_at, pm25_ugm3, raw')
    .in('station_id', [bam.id, ag.id])
    .gte('observed_at', since)
    .order('observed_at')
    .returns<ObsRow[]>();
  if (error) throw new DbFailure(describeDbError('reading aq_observations', error));

  const bamRows = (data ?? []).filter((r) => r.station_id === bam.id);
  const agRows = (data ?? []).filter((r) => r.station_id === ag.id);

  const bamHourly = hourlyMeans(bamRows, (r) => r.pm25_ugm3);
  const agCorrected = hourlyMeans(agRows, (r) => r.pm25_ugm3);
  const agRaw = hourlyMeans(agRows, (r) => (typeof r.raw?.pm02_raw === 'number' ? r.raw.pm02_raw : null));

  const shared = [...bamHourly.keys()].filter((k) => agCorrected.has(k)).sort();

  console.log(`Co-location check - BMKG headquarters, Kemayoran (stored hourly means, last ${hours}h)`);
  console.log('-'.repeat(72));
  console.log(`  BAM samples stored          ${bamRows.length} across ${bamHourly.size} hour(s)`);
  console.log(`  AirGradient samples stored  ${agRows.length} across ${agCorrected.size} hour(s)`);
  console.log(`  hours both reported         ${shared.length}`);

  if (shared.length === 0) {
    console.log('\nNo overlapping hours yet - nothing to compare.');
    console.log('Both feeds need to have run at least once; try a wider --hours window.');
    process.exitCode = 1;
    return;
  }

  let sumRawGap = 0;
  let sumCorrGap = 0;
  let sumAbsRaw = 0;
  let sumAbsCorr = 0;
  let rawPairs = 0;

  console.log('\n  hour (UTC)         BAM     raw   corrected   gap raw   gap corr');
  for (const key of shared) {
    const hour = `${new Date(Number(key) * 3_600_000).toISOString().slice(0, 13)}:00`;
    const b = bamHourly.get(key) as number;
    const c = agCorrected.get(key) as number;
    const r = agRaw.get(key);
    const gapCorr = c - b;
    sumCorrGap += gapCorr;
    sumAbsCorr += Math.abs(gapCorr);

    let gapRawLabel = '-';
    if (r !== undefined) {
      const gapRaw = r - b;
      sumRawGap += gapRaw;
      sumAbsRaw += Math.abs(gapRaw);
      rawPairs += 1;
      gapRawLabel = gapRaw.toFixed(1);
    }
    console.log(
      `  ${hour}  ${b.toFixed(1).padStart(6)}  ${(r === undefined ? '-' : r.toFixed(1)).padStart(6)}  ` +
        `${c.toFixed(1).padStart(9)}  ${gapRawLabel.padStart(8)}  ${gapCorr.toFixed(1).padStart(9)}`,
    );
  }

  const n = shared.length;
  const maeCorr = sumAbsCorr / n;
  console.log('-'.repeat(72));
  console.log(
    `  mean bias   corrected ${sumCorrGap / n >= 0 ? '+' : ''}${(sumCorrGap / n).toFixed(2)} ug/m3` +
      (rawPairs > 0 ? `   raw ${sumRawGap / rawPairs >= 0 ? '+' : ''}${(sumRawGap / rawPairs).toFixed(2)} ug/m3` : ''),
  );
  console.log(
    `  MAE         corrected ${maeCorr.toFixed(2)} ug/m3` +
      (rawPairs > 0 ? `   raw ${(sumAbsRaw / rawPairs).toFixed(2)} ug/m3` : '') +
      `   over ${n} paired hour(s)`,
  );

  if (rawPairs > 0) {
    const maeRaw = sumAbsRaw / rawPairs;
    if (maeRaw > 0) {
      console.log(`  correction closed ${((1 - maeCorr / maeRaw) * 100).toFixed(0)}% of the mean absolute gap`);
      if (maeCorr > maeRaw) {
        console.log('\n  ! the correction made the disagreement WORSE across these hours - investigate.');
      }
    }
  }
  if (n < 6) {
    console.log(`\n  Only ${n} paired hour(s): indicative, not conclusive. Re-run with a wider window.`);
  }
}

async function main(): Promise<void> {
  const hours = intFlag(process.argv.slice(2), 'hours', 0);
  if (hours > 0) {
    await compareStoredHours(hours);
    return;
  }
  await compareLiveSpot();
}

async function compareLiveSpot(): Promise<void> {
  const token = process.env.WAQI_TOKEN?.trim();
  if (!token) {
    console.error('Missing WAQI_TOKEN (see .env.example).');
    process.exitCode = 1;
    return;
  }
  const now = new Date();

  /* -- reference: the Kemayoran BAM via WAQI ------------------------------- */
  const waqiRes = await fetchJson<unknown>(
    `https://api.waqi.info/feed/@${WAQI_KEMAYORAN_UID}/?token=${encodeURIComponent(token)}`,
  );
  if (!waqiRes.ok) {
    console.error(`WAQI fetch failed: ${waqiRes.message}`);
    process.exitCode = 1;
    return;
  }
  const ref = parseWaqiFeed(waqiRes.data, { now, staleHours: STALE_FEED_HOURS });
  if (!ref.ok) {
    console.error(`Kemayoran reference unusable: ${ref.reason} (${ref.detail})`);
    process.exitCode = 1;
    return;
  }

  /* -- subject: the AirGradient unit at BMKG HQ ---------------------------- */
  const agRes = await fetchJson<unknown>(AIRGRADIENT_WORLD_URL);
  if (!agRes.ok) {
    console.error(`AirGradient fetch failed: ${agRes.message}`);
    process.exitCode = 1;
    return;
  }
  const parsed = parseAirGradientWorld(agRes.data, {
    now,
    staleHours: STALE_FEED_HOURS,
    wanted: new Set([AIRGRADIENT_BMKG_ID]),
  });
  if (!parsed.ok || parsed.readings.length === 0) {
    const why = parsed.ok
      ? parsed.skipped.map((s) => `${s.reason}: ${s.detail}`).join('; ') || 'absent from world payload'
      : `${parsed.reason}: ${parsed.detail}`;
    console.error(`AirGradient BMKG 1 unusable: ${why}`);
    process.exitCode = 1;
    return;
  }

  const ag = parsed.readings[0];
  const raw = ag.raw as { pm02_raw: number; rhum: number; measured_at: string };
  const uncorrected = raw.pm02_raw;
  const corrected = ag.pm25Corrected;
  const reference = ref.pm25;

  /* -- the comparison ------------------------------------------------------ */
  const gapRaw = uncorrected - reference;
  const gapCorrected = corrected - reference;
  const closed = Math.abs(gapRaw) < 0.01 ? 100 : (1 - Math.abs(gapCorrected) / Math.abs(gapRaw)) * 100;

  console.log('Co-location check — BMKG headquarters, Kemayoran');
  console.log('─'.repeat(60));
  console.log(`  reference BAM (waqi @${WAQI_KEMAYORAN_UID})   ${reference} µg/m³  @ ${ref.observedAt} (AQI ${ref.aqi})`);
  console.log(`  AirGradient raw pm02          ${uncorrected} µg/m³  @ ${raw.measured_at} (RH ${raw.rhum}%)`);
  console.log(`  AirGradient EPA-corrected     ${corrected} µg/m³`);
  console.log('─'.repeat(60));
  console.log(`  gap before correction         ${gapRaw >= 0 ? '+' : ''}${gapRaw.toFixed(1)} µg/m³`);
  console.log(`  gap after correction          ${gapCorrected >= 0 ? '+' : ''}${gapCorrected.toFixed(1)} µg/m³`);
  console.log(`  correction closed             ${closed.toFixed(0)}% of the gap`);
  if (Math.abs(gapCorrected) > Math.abs(gapRaw)) {
    console.log('\n  ⚠ correction made the disagreement WORSE — investigate before trusting ingestion.');
  }
  console.log(
    '\n  ONE SPOT COMPARISON. The BAM value is an hourly average served ~1h behind;\n' +
      '  the AirGradient value is an instant from minutes ago, so much of this gap can\n' +
      '  be timing rather than sensor error, and the percentage above is a single\n' +
      '  sample of a noisy quantity.\n' +
      '  For a defensible number, compare stored hourly means instead:\n' +
      '      npm run verify:colocation -- --hours 48',
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
