/**
 * verify-aqi-table.ts — which EPA breakpoint table is WAQI actually using?
 *
 * Run:
 *   npm run verify:aqi-table
 *
 * ---------------------------------------------------------------------------
 * Why this script exists
 * ---------------------------------------------------------------------------
 * WAQI publishes `iaqi.pm25.v` as a US-EPA AQI sub-index. Turning it back into
 * µg/m³ requires knowing which breakpoint table produced it, and there are two
 * in circulation that disagree precisely where Jakarta lives:
 *
 *   AQI  80  ->  25.6 µg/m³ (pre-2024)  vs  22.6 (2024 revision)
 *   AQI 160  ->  71.3 µg/m³ (pre-2024)  vs  60.3 (2024 revision)
 *
 * Guessing wrong biases every Indonesian reading by 10-15%, in a way no test
 * can catch because both answers look entirely reasonable. WAQI does not
 * document the choice, so it has to be measured.
 *
 * Singapore is the only place where the same air is published both ways: WAQI
 * mirrors the NEA regional feeds as AQI sub-indices (uids 1662-1666), while
 * data.gov.sg publishes the identical readings as native µg/m³. Convert the
 * truth forward through both tables and see which reproduces WAQI's number.
 *
 * ---------------------------------------------------------------------------
 * The trap that makes this test lie
 * ---------------------------------------------------------------------------
 * WAQI's feed runs about an hour behind data.gov.sg. Comparing "WAQI now"
 * against "data.gov.sg now" therefore compares *different hours*, and since
 * PM2.5 moves hour to hour the comparison fails against both tables — a
 * confident false negative.
 *
 * So the alignment is on WAQI's own `time.iso` hour: read the hour WAQI says it
 * is reporting, then fetch that same hour from data.gov.sg. This is the entire
 * difference between the check working and not.
 *
 * Exit code is non-zero if the winner is not what src/lib/aqi.ts has hardcoded
 * — so this can be wired into CI later without further thought.
 */

import {
  AQI_TABLES,
  DEFAULT_PM25_BREAKPOINTS,
  pm25ToAqi,
  type AqiBreakpointTable,
} from '../src/lib/aqi';
import { toLocalDate } from '../src/lib/format';
import type { AqiTableId, SgRegionName } from '../src/lib/types';
import { parseDataGovSgPm25 } from './lib/datagovsg';
import { fetchJson, sleep } from './lib/http';
import { parseWaqiFeed } from './lib/waqi';

/**
 * WAQI's mirror of the five NEA regional feeds, confirmed live on 2026-08-16 by
 * reading `data.city.name` from each (`"North, Singapore"` and so on).
 *
 * Note these are used *only* here. Production reads Singapore from data.gov.sg:
 * same readings, native µg/m³ with no inversion to get wrong, and the Singapore
 * Open Data Licence permits storage and redisplay outright.
 */
const NEA_MIRRORS: { uid: number; region: SgRegionName }[] = [
  { uid: 1662, region: 'north' },
  { uid: 1663, region: 'south' },
  { uid: 1664, region: 'east' },
  { uid: 1665, region: 'west' },
  { uid: 1666, region: 'central' },
];

interface Comparison {
  region: SgRegionName;
  uid: number;
  hour: string;
  truthUgm3: number;
  waqiAqi: number;
  /** Predicted AQI per table id. */
  predicted: Record<AqiTableId, number | null>;
}

async function main(): Promise<void> {
  const token = process.env.WAQI_TOKEN?.trim();
  if (!token) {
    console.error('Missing WAQI_TOKEN. Add it to .env.local (see .env.example) or export it before running.');
    process.exitCode = 1;
    return;
  }

  const now = new Date();
  const tables: AqiBreakpointTable[] = Object.values(AQI_TABLES);

  console.log('Co-location check: WAQI NEA mirrors (AQI sub-index) vs data.gov.sg (native µg/m³)\n');

  /* -- 1. WAQI side -------------------------------------------------------- */
  const waqi: { uid: number; region: SgRegionName; aqi: number; observedAt: string }[] = [];
  for (const [i, m] of NEA_MIRRORS.entries()) {
    if (i > 0) await sleep(250);
    const res = await fetchJson<unknown>(`https://api.waqi.info/feed/@${m.uid}/?token=${encodeURIComponent(token)}`);
    if (!res.ok) {
      console.error(`  ✗ @${m.uid} (${m.region}): ${res.message}`);
      continue;
    }
    // A wide staleness budget: this is a table-identification exercise, and an
    // hour-old reading identifies the table just as well as a fresh one.
    const parsed = parseWaqiFeed(res.data, { now, staleHours: 24 });
    if (!parsed.ok) {
      console.error(`  ✗ @${m.uid} (${m.region}): ${parsed.reason} — ${parsed.detail}`);
      continue;
    }
    waqi.push({ uid: m.uid, region: m.region, aqi: parsed.aqi, observedAt: parsed.observedAt });
    console.log(`  WAQI @${m.uid} ${m.region.padEnd(8)} AQI ${String(parsed.aqi).padStart(3)}  @ ${parsed.observedAt}`);
  }

  if (waqi.length === 0) {
    console.error('\nNo WAQI readings — cannot verify.');
    process.exitCode = 1;
    return;
  }

  /* -- 2. data.gov.sg side, for the dates WAQI's hours fall in -------------- */
  // Fetch by Singapore local date, because that is the API's unit. WAQI's hour
  // can sit on the previous local date near midnight, so derive the dates from
  // the readings rather than assuming "today".
  const dates = [...new Set(waqi.map((w) => toLocalDate(w.observedAt, 'Asia/Singapore')))].filter(
    (d): d is string => d !== null,
  );

  const truth = new Map<string, number>(); // `${region}@${isoHour}` -> µg/m³
  for (const date of dates) {
    const res = await fetchJson<unknown>(`https://api-open.data.gov.sg/v2/real-time/api/pm25?date=${date}`);
    if (!res.ok) {
      console.error(`  ✗ data.gov.sg ${date}: ${res.message}`);
      continue;
    }
    const parsed = parseDataGovSgPm25(res.data);
    if (!parsed.ok) {
      console.error(`  ✗ data.gov.sg ${date}: ${parsed.reason} — ${parsed.detail}`);
      continue;
    }
    for (const r of parsed.readings) truth.set(`${r.region}@${r.observedAt}`, r.pm25);
  }

  /* -- 3. compare ---------------------------------------------------------- */
  const comparisons: Comparison[] = [];
  for (const w of waqi) {
    // THE ALIGNMENT. Keyed on WAQI's own hour, never on "now".
    const t = truth.get(`${w.region}@${w.observedAt}`);
    if (t === undefined) {
      console.error(`  ! ${w.region}: data.gov.sg has no reading for ${w.observedAt} — skipping`);
      continue;
    }
    const predicted = {} as Record<AqiTableId, number | null>;
    for (const table of tables) predicted[table.id] = pm25ToAqi(t, table);
    comparisons.push({ region: w.region, uid: w.uid, hour: w.observedAt, truthUgm3: t, waqiAqi: w.aqi, predicted });
  }

  if (comparisons.length === 0) {
    console.error('\nNo aligned hours — cannot verify. (Is data.gov.sg lagging WAQI today?)');
    process.exitCode = 1;
    return;
  }

  console.log(`\nAligned on WAQI's reported hour (${comparisons[0].hour}):\n`);
  const header = `  region    truth µg/m³   WAQI AQI` + tables.map((t) => `   ${t.id.padStart(13)}`).join('');
  console.log(header);
  console.log(`  ${'-'.repeat(header.length - 2)}`);

  const score: Record<string, number> = {};
  // A region where both tables predict the same AQI cannot discriminate between
  // them, and counting it as evidence for both would flatter whichever loses.
  let discriminating = 0;

  for (const c of comparisons) {
    const values = tables.map((t) => c.predicted[t.id]);
    const distinct = new Set(values.map((v) => String(v)));
    if (distinct.size > 1) discriminating += 1;

    const cells = tables
      .map((t) => {
        const v = c.predicted[t.id];
        const hit = v === c.waqiAqi;
        if (hit && distinct.size > 1) score[t.id] = (score[t.id] ?? 0) + 1;
        return `   ${`${v ?? '—'}${hit ? ' ✓' : '  '}`.padStart(13)}`;
      })
      .join('');

    console.log(
      `  ${c.region.padEnd(9)} ${String(c.truthUgm3).padStart(9)}   ${String(c.waqiAqi).padStart(8)}${cells}` +
        (distinct.size === 1 ? '   (degenerate — tables agree here)' : ''),
    );
  }

  /* -- 4. verdict ---------------------------------------------------------- */
  console.log(`\n  ${discriminating} of ${comparisons.length} comparison(s) can tell the tables apart.\n`);
  for (const table of tables) {
    console.log(`  ${table.id.padEnd(14)} ${score[table.id] ?? 0}/${discriminating}   ${table.label}`);
  }

  if (discriminating === 0) {
    console.error('\n✗ Every comparison was degenerate — both tables agree at these concentrations.');
    console.error('  Re-run when readings are outside 30-40 µg/m³, where the tables diverge.');
    process.exitCode = 1;
    return;
  }

  const ranked = tables
    .map((t) => ({ id: t.id, hits: score[t.id] ?? 0 }))
    .sort((a, b) => b.hits - a.hits);
  const winner = ranked[0];

  console.log(`\n  configured in src/lib/aqi.ts: ${DEFAULT_PM25_BREAKPOINTS.id}`);
  console.log(`  measured winner:              ${winner.id} (${winner.hits}/${discriminating})`);

  if (winner.hits < discriminating) {
    console.error(
      '\n! The winning table did not match every discriminating comparison. Treat this as\n' +
        '  inconclusive rather than as a migration signal — one mismatched hour is more\n' +
        '  likely a revised reading than a change of breakpoints.',
    );
  }

  if (winner.id !== DEFAULT_PM25_BREAKPOINTS.id && winner.hits === discriminating) {
    console.error(
      `\n✗ WAQI appears to have migrated to ${winner.id}.\n` +
        '  1. Change DEFAULT_PM25_BREAKPOINTS in src/lib/aqi.ts.\n' +
        '  2. Every stored row records the table it used in aq_observations.aqi_table,\n' +
        `     so historic rows can be corrected in place — no re-fetch needed.`,
    );
    process.exitCode = 1;
    return;
  }

  console.log('\n✓ The configured breakpoint table matches what WAQI is publishing.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
