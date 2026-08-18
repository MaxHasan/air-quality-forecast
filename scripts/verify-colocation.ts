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
 * Interpreting the answer honestly:
 *   - The BAM reports hourly and WAQI serves it ~1 h behind; the AirGradient
 *     reading is minutes old. The script aligns to the BAM's hour but a
 *     residual timing mismatch of one hour is inherent — do not read a single
 *     run as a verdict. Run it a few times across different conditions.
 *   - Expect the correction to NARROW the gap, not close it (raw ~52 vs BAM
 *     ~29 on discovery day). A corrected value persistently on the wrong side
 *     of the raw one, or a gap that grows after correction, means the formula
 *     is being misapplied and ingestion should be treated as suspect.
 *   - Exit code 1 only for "could not compare" (a feed failed). Disagreement
 *     is a *finding*, not a failure — the whole point is to see it.
 */

import { STALE_FEED_HOURS } from '../src/lib/stations';
import { AIRGRADIENT_WORLD_URL, parseAirGradientWorld } from './lib/airgradient';
import { fetchJson } from './lib/http';
import { parseWaqiFeed } from './lib/waqi';

const WAQI_KEMAYORAN_UID = '8294';
const AIRGRADIENT_BMKG_ID = '199980';

async function main(): Promise<void> {
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
    '\n  One run is one weather condition. The BAM lags ~1h behind the optical\n' +
      '  sensor, so ±(one hour of change) of the gap is timing, not sensor error.',
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
