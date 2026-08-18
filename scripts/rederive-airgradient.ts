/**
 * rederive-airgradient.ts — recompute stored AirGradient concentrations from
 * their retained raw inputs.
 *
 * Run:
 *   npm run rederive:airgradient                 # dry run: report drift, write nothing
 *   npm run rederive:airgradient -- --write      # apply the recomputed values
 *   npm run rederive:airgradient -- --days 30    # limit the window (default: all)
 *
 * WHY THIS EXISTS
 * The humidity correction is applied at *write* time, so `pm25_ugm3` is a
 * derived number and the formula that produced it is a dependency of every
 * stored row. Three file headers used to promise that history "can be
 * re-derived if the correction is ever revised" — and nothing implemented it.
 * A promised safety net that does not exist is worse than an acknowledged gap:
 * it is the reason nobody notices the gap until they need the net.
 *
 * Every AirGradient row keeps `raw.pm02_raw`, `raw.rhum` and `raw.correction`
 * precisely so this is possible. This script closes the loop:
 *
 *   - recompute each row from its own retained inputs, with today's formula;
 *   - report where the stored value disagrees, and by how much;
 *   - with --write, update the disagreeing rows and stamp the current
 *     CORRECTION_ID so a later run can tell recomputed rows from stale ones.
 *
 * It is idempotent by construction: a second run recomputes the same inputs
 * with the same formula and finds nothing to change.
 *
 * A row whose raw inputs are missing or implausible is REPORTED, NEVER
 * SILENTLY DROPPED — it means the writer stored something it should not have,
 * and quietly leaving it in place while claiming a clean re-derivation would
 * repeat the original sin at one remove.
 */

import { CORRECTION_ID, correctAirGradientPm25, isPlausibleRh } from './lib/airgradient';
import { DbFailure, describeDbError, serviceClient } from './lib/db';
import { hasFlag, intFlag, reportFatal } from './lib/run-log';

interface StoredRow {
  station_id: number;
  observed_at: string;
  pm25_ugm3: number | null;
  raw: { pm02_raw?: unknown; rhum?: unknown; correction?: unknown } | null;
}

/** Rows are read in pages; PostgREST silently caps a select at 1000. */
const PAGE = 1000;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const write = hasFlag(argv, 'write');
  const days = intFlag(argv, 'days', 0); // 0 = the whole history

  const db = serviceClient();

  // Identified by the provenance stamp rather than by joining stations: a
  // station that ever changed source would otherwise orphan its own history.
  const rows: StoredRow[] = [];
  for (let offset = 0; ; offset += PAGE) {
    let query = db
      .from('aq_observations')
      .select('station_id, observed_at, pm25_ugm3, raw')
      .eq('raw->>source', 'airgradient')
      .order('observed_at', { ascending: false });

    if (days > 0) {
      query = query.gte('observed_at', new Date(Date.now() - days * 86_400_000).toISOString());
    }

    const { data, error } = await query.range(offset, offset + PAGE - 1).returns<StoredRow[]>();
    if (error) throw new DbFailure(describeDbError('reading aq_observations', error));
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE) break;
  }

  if (rows.length === 0) {
    console.log('No AirGradient observations stored yet — nothing to re-derive.');
    return;
  }

  const changed: { row: StoredRow; from: number | null; to: number; delta: number }[] = [];
  const unusable: { row: StoredRow; why: string }[] = [];
  let identical = 0;

  for (const row of rows) {
    const rawPm = typeof row.raw?.pm02_raw === 'number' ? row.raw.pm02_raw : null;
    const rh = typeof row.raw?.rhum === 'number' ? row.raw.rhum : null;

    if (rawPm === null) {
      unusable.push({ row, why: 'no pm02_raw retained' });
      continue;
    }
    if (rh === null || !isPlausibleRh(rh)) {
      unusable.push({ row, why: `rhum=${rh ?? 'absent'} is not usable` });
      continue;
    }

    const recomputed = correctAirGradientPm25(rawPm, rh);
    if (recomputed === null) {
      unusable.push({ row, why: `pm02_raw=${rawPm} rhum=${rh} does not correct` });
      continue;
    }

    // One decimal is the stored precision, so anything under half of that is
    // float noise rather than a real revision.
    if (row.pm25_ugm3 !== null && Math.abs(recomputed - row.pm25_ugm3) < 0.05) {
      identical += 1;
      continue;
    }
    changed.push({ row, from: row.pm25_ugm3, to: recomputed, delta: recomputed - (row.pm25_ugm3 ?? 0) });
  }

  /* -- report ------------------------------------------------------------- */
  const stamps = new Set(rows.map((r) => (typeof r.raw?.correction === 'string' ? r.raw.correction : '(none)')));
  console.log(`AirGradient re-derivation — ${rows.length} stored row(s)`);
  console.log('-'.repeat(64));
  console.log(`  formula in code          ${CORRECTION_ID}`);
  console.log(`  formulas stamped on rows ${[...stamps].join(', ')}`);
  console.log(`  unchanged                ${identical}`);
  console.log(`  would change             ${changed.length}`);
  console.log(`  unusable inputs          ${unusable.length}`);

  if (changed.length > 0) {
    const deltas = changed.map((c) => c.delta);
    const absMax = Math.max(...deltas.map((d) => Math.abs(d)));
    const meanDelta = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    console.log(`  mean shift               ${meanDelta >= 0 ? '+' : ''}${meanDelta.toFixed(2)} ug/m3`);
    console.log(`  largest shift            ${absMax.toFixed(2)} ug/m3`);
    console.log('\n  sample of changes:');
    for (const c of changed.slice(0, 8)) {
      console.log(
        `    station=${c.row.station_id} ${c.row.observed_at}  ${c.from ?? '-'} -> ${c.to}  ` +
          `(${c.delta >= 0 ? '+' : ''}${c.delta.toFixed(1)})`,
      );
    }
    if (changed.length > 8) console.log(`    ... and ${changed.length - 8} more`);
  }

  if (unusable.length > 0) {
    console.log('\n  ! rows that cannot be re-derived from what was stored:');
    for (const u of unusable.slice(0, 8)) {
      console.log(`    station=${u.row.station_id} ${u.row.observed_at} - ${u.why}`);
    }
    if (unusable.length > 8) console.log(`    ... and ${unusable.length - 8} more`);
    console.log('    These predate, or violate, the validation in the writer. Investigate before trusting them.');
  }

  if (!write) {
    console.log(
      changed.length > 0
        ? '\nDry run. Re-run with --write to apply.'
        : '\nDry run. Nothing to apply: stored values already match the current formula.',
    );
    return;
  }

  if (changed.length === 0) {
    console.log('\nNothing to write.');
    return;
  }

  /* -- apply -------------------------------------------------------------- */
  let written = 0;
  for (const c of changed) {
    const nextRaw = { ...(c.row.raw ?? {}), correction: CORRECTION_ID, rederived_at: new Date().toISOString() };
    const { error } = await db
      .from('aq_observations')
      .update({ pm25_ugm3: c.to, raw: nextRaw } as never)
      .eq('station_id', c.row.station_id)
      .eq('observed_at', c.row.observed_at);
    if (error) {
      console.error(`  x station=${c.row.station_id} ${c.row.observed_at}: ${describeDbError('updating', error)}`);
      continue;
    }
    written += 1;
  }
  console.log(`\nWrote ${written} of ${changed.length} row(s).`);
  console.log('Daily rollups are NOT recomputed here - run `npm run rollup -- --days <n>` to fold the');
  console.log('new values into daily_aq, or the rollups will disagree with the observations behind them.');
}

main().catch(reportFatal);
