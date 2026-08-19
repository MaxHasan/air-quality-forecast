/**
 * fit-wind-model.ts — calibrate and validate the `wind_regression` model.
 *
 * Run:
 *   npm run calibrate                 # fit + horizon-by-horizon holdout report
 *   npm run calibrate -- --sql        # also emit seed SQL
 *   npm run calibrate -- --write      # upsert into model_coefficients
 *   npm run calibrate -- --refresh    # re-download ERA5 instead of using cache
 *
 * ===========================================================================
 * WHAT GETS SHIPPED, AND WHY IT IS NOT WHAT THE PLAN ASSUMED
 * ===========================================================================
 * The model:
 *
 *     PM2.5(target) = intercept
 *                   + b_lag  * PM2.5(last observed day)
 *                   + b_wind * windAvg(target, from the forecast)
 *
 * Three departures from the original 2024 analysis, each forced by a
 * measurement rather than a preference.
 *
 * 1. WEATHER FROM ERA5, NOT BMKG.
 *    BMKG's daily `ws_avg` at Kemayoran is an integer in m/s and over 729 days
 *    takes five values: 0 (77 days), 1 (484), 2 (150), 3 (7), 4 (6). Two thirds
 *    of the record is the single value "1". Worse than the lost resolution:
 *    production feeds the model Open-Meteo wind, a different instrument on a
 *    different scale, so a BMKG-fitted slope would be misapplied at inference.
 *    ERA5 is Open-Meteo's own archive — ~240 distinct daily values over the
 *    same window, and the same lineage as the live forecast. R² rises from
 *    0.20 to 0.42 in Central Jakarta on that change alone.
 *
 * 2. SAME-DAY WEATHER, NOT LAGGED.
 *    The original lagged because only observed weather was available;
 *    yesterday's wind was the only thing knowable ahead. This app has a 16-day
 *    wind forecast, so the target day's own wind is knowable, and it is the
 *    stronger predictor.
 *
 * 3. YESTERDAY'S PM2.5 IS IN THE MODEL.
 *    This is the big one. Daily PM2.5 is strongly autocorrelated, which makes
 *    naive persistence a much harder benchmark than expected: on the 2023
 *    holdout it scores 6.29 MAE in Central Jakarta against 11.17 for
 *    climatology. A wind-and-temperature model, despite R²=0.42 and t=-20 on
 *    the wind term, loses to it outright at one day ahead (10.33 MAE).
 *    Wind explains a great deal about the *level* of pollution and rather less
 *    about the *change* from a level you already know.
 *    Combining the two beats both: yesterday's level anchors it, wind supplies
 *    the correction, and the wind coefficient stays firmly negative
 *    (-6.8 Central Jakarta, -9.3 BSD) — the original finding, intact and now
 *    carrying its weight.
 *
 * The honest caveat, printed with the results: this backtest feeds the models
 * ERA5 *actuals* for the target day, i.e. a perfect wind forecast. Live skill
 * will be lower by whatever Open-Meteo's wind error costs, and that gap widens
 * with horizon. The running MAE tracker on /models measures the real thing —
 * which is exactly why all three models are stored and scored in production
 * rather than one being crowned here.
 * ===========================================================================
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { olsFit2, olsPredict, type OlsFit, type OlsSample } from '../../src/lib/regression';
import { LOCATIONS, type LocationConfig } from '../../src/lib/stations';
import type {
  HorizonDays,
  Json,
  LocationSlug,
  ModelCoefficientMap,
  ModelCoefficientsInsert,
  ModelFitStats,
} from '../../src/lib/types';

const DATA_DIR = join(process.cwd(), 'data', 'historical');
const CACHE_DIR = join(DATA_DIR, 'era5');
const ARCHIVE_START = '2021-12-31';
const ARCHIVE_END = '2023-12-15';
const TRAIN_FRACTION = 0.8;
const HORIZONS: HorizonDays[] = [1, 2, 3];

/**
 * Version stamped on every seeded coefficient row, and the key
 * `model_coefficients` conflicts on. Named because it was previously the bare
 * literal `1` in the SQL template, in the inserted row and in the lookup key
 * that pairs them -- three places that had to agree with nothing enforcing it.
 */
const COEFFICIENT_VERSION = 1;

/* -------------------------------------------------------------------------- */
/* Loading                                                                    */
/* -------------------------------------------------------------------------- */

function readCsv(file: string): Record<string, string>[] {
  const path = join(DATA_DIR, file);
  if (!existsSync(path)) {
    throw new Error(`Missing ${path}\nStage the archive first — see data/historical/README.md`);
  }
  const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '');
  const header = lines[0].split(',').map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    const row: Record<string, string> = {};
    header.forEach((h, i) => {
      row[h] = (cells[i] ?? '').trim();
    });
    return row;
  });
}

const numOrNull = (v: string | undefined): number | null => {
  if (v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Nafas hourly PM2.5 -> daily mean by local (WIB) date. */
function loadDailyPm25(file: string): Map<string, number> {
  const acc = new Map<string, { sum: number; n: number }>();
  for (const row of readCsv(file)) {
    const pm = numOrNull(row['PM2.5']);
    const date = row.DateTime?.split(' ')[0];
    if (pm === null || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const a = acc.get(date) ?? { sum: 0, n: 0 };
    a.sum += pm;
    a.n += 1;
    acc.set(date, a);
  }
  const out = new Map<string, number>();
  for (const [date, { sum, n }] of acc) if (n >= 12) out.set(date, sum / n);
  return out;
}

interface DailyWeather {
  windAvgMs: number;
  tempAvgC: number;
}

async function loadEra5(loc: LocationConfig, refresh: boolean): Promise<Map<string, DailyWeather>> {
  const cachePath = join(CACHE_DIR, `${loc.slug}.json`);
  let payload: { hourly?: { time: string[]; temperature_2m?: (number | null)[]; wind_speed_10m?: (number | null)[] }; error?: boolean; reason?: string };

  if (!refresh && existsSync(cachePath)) {
    payload = JSON.parse(readFileSync(cachePath, 'utf8'));
  } else {
    const url =
      `https://archive-api.open-meteo.com/v1/archive?latitude=${loc.lat}&longitude=${loc.lon}` +
      `&start_date=${ARCHIVE_START}&end_date=${ARCHIVE_END}` +
      `&hourly=temperature_2m,wind_speed_10m,wind_direction_10m,boundary_layer_height` +
      `&timezone=${encodeURIComponent(loc.timezone)}&wind_speed_unit=ms`;
    const res = await fetch(url);
    payload = await res.json();
    if (!payload || payload.error) throw new Error(`ERA5 fetch failed for ${loc.slug}: ${payload?.reason}`);
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(payload));
  }

  const h = payload.hourly;
  if (!h) throw new Error(`ERA5 payload for ${loc.slug} has no hourly block`);

  const acc = new Map<string, { wind: number; temp: number; n: number }>();
  for (let i = 0; i < h.time.length; i += 1) {
    const date = h.time[i].slice(0, 10); // already local — `timezone` was requested
    const wind = h.wind_speed_10m?.[i];
    const temp = h.temperature_2m?.[i];
    if (wind == null || temp == null) continue;
    const a = acc.get(date) ?? { wind: 0, temp: 0, n: 0 };
    a.wind += wind;
    a.temp += temp;
    a.n += 1;
    acc.set(date, a);
  }

  const out = new Map<string, DailyWeather>();
  for (const [date, a] of acc) {
    if (a.n < 20) continue;
    out.set(date, { windAvgMs: a.wind / a.n, tempAvgC: a.temp / a.n });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Evaluation                                                                 */
/* -------------------------------------------------------------------------- */

const shiftDate = (iso: string, days: number): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

const mae = (pairs: { p: number; a: number }[]): number =>
  pairs.length === 0 ? Number.NaN : pairs.reduce((s, x) => s + Math.abs(x.p - x.a), 0) / pairs.length;

/** Shipped spec: yesterday's level + the target day's forecast wind. */
function buildHybridRows(pm: Map<string, number>, wx: Map<string, DailyWeather>, lagDays: number): OlsSample[] {
  const rows: OlsSample[] = [];
  for (const date of [...pm.keys()].sort()) {
    const w = wx.get(date);
    const lag = pm.get(shiftDate(date, -lagDays));
    if (!w || lag === undefined) continue;
    rows.push({ x1: lag, x2: w.windAvgMs, y: pm.get(date) as number });
  }
  return rows;
}

/** Reference spec, closest to the original analysis: wind + temperature only. */
function buildWeatherOnlyRows(pm: Map<string, number>, wx: Map<string, DailyWeather>): OlsSample[] {
  const rows: OlsSample[] = [];
  for (const date of [...pm.keys()].sort()) {
    const w = wx.get(date);
    if (!w) continue;
    rows.push({ x1: w.windAvgMs, x2: w.tempAvgC, y: pm.get(date) as number });
  }
  return rows;
}

interface HorizonSkill {
  horizon: HorizonDays;
  hybrid: number;
  weatherOnly: number;
  persistence: number;
  climatology: number;
}

interface LocationResult {
  loc: LocationConfig;
  /** Fitted on the training split, used for the holdout comparison. */
  trainHybrid: OlsFit;
  trainWeatherOnly: OlsFit;
  /** Fitted on everything — the coefficients that get seeded. */
  final: OlsFit;
  skill: HorizonSkill[];
  firstDate: string;
  lastDate: string;
  trainRange: string;
  testRange: string;
  passes: boolean;
  gates: string[];
}

/* -------------------------------------------------------------------------- */
/* Reporting                                                                  */
/* -------------------------------------------------------------------------- */

const f = (n: number | null | undefined, dp = 3): string =>
  n === null || n === undefined || !Number.isFinite(n) ? '—' : n.toFixed(dp);

function report(r: LocationResult): void {
  console.log(`\n${'='.repeat(78)}`);
  console.log(`${r.loc.name}   (${r.loc.slug})`);
  console.log('='.repeat(78));
  console.log(`  record   ${r.firstDate} -> ${r.lastDate}   n=${r.final.n} days`);
  console.log(`  holdout  train ${r.trainRange}   test ${r.testRange}`);
  console.log('');
  console.log('  shipped   PM2.5(d) = b0 + b_lag·PM2.5(last obs) + b_wind·wind(d)');
  console.log(
    `            b_lag ${f(r.trainHybrid.b1).padStart(7)} (t=${f(r.trainHybrid.terms.b1.tStat, 1)})   ` +
      `b_wind ${f(r.trainHybrid.b2).padStart(8)} (t=${f(r.trainHybrid.terms.b2.tStat, 1)})   R²=${f(r.trainHybrid.r2, 3)}`,
  );
  console.log('  reference PM2.5(d) = b0 + b_wind·wind(d) + b_temp·temp(d)   [closest to the 2024 analysis]');
  console.log(
    `            b_wind ${f(r.trainWeatherOnly.b1).padStart(7)} (t=${f(r.trainWeatherOnly.terms.b1.tStat, 1)})   ` +
      `b_temp ${f(r.trainWeatherOnly.b2).padStart(8)} (t=${f(r.trainWeatherOnly.terms.b2.tStat, 1)})   R²=${f(r.trainWeatherOnly.r2, 3)}`,
  );
  console.log('');
  console.log('  holdout MAE (µg/m³), lower is better');
  console.log('   horizon | SHIPPED hybrid | wind+temp | persistence | climatology');
  console.log('   --------|----------------|-----------|-------------|------------');
  for (const s of r.skill) {
    const best = Math.min(s.hybrid, s.weatherOnly, s.persistence, s.climatology);
    const mark = (v: number) => (v === best ? '*' : ' ');
    console.log(
      `      h=${s.horizon}   |${mark(s.hybrid)}${f(s.hybrid, 2).padStart(13)} |${mark(s.weatherOnly)}${f(s.weatherOnly, 2).padStart(8)} |` +
        `${mark(s.persistence)}${f(s.persistence, 2).padStart(10)} |${mark(s.climatology)}${f(s.climatology, 2).padStart(11)}`,
    );
  }
  console.log('   (* = best at that horizon)');
  console.log('');
  console.log('  seeded coefficients (fit on the complete record):');
  console.log(
    `    PM2.5 = ${f(r.final.intercept, 3)} + ${f(r.final.b1, 3)}·PM2.5(lag) + ${f(r.final.b2, 3)}·wind` +
      `   R²=${f(r.final.r2, 3)}  RMSE=${f(r.final.rmse, 2)}`,
  );
  console.log('');
  console.log(`  gates: ${r.passes ? 'PASS' : 'FAIL'}`);
  for (const g of r.gates) console.log(`    ${g}`);
}

/**
 * Every key this script measures, and therefore fully owns on each refit.
 *
 * `stats` holds two different kinds of thing: what a fit measured, and
 * annotations other migrations stamp on afterwards (0006 writes
 * `station_mix_changed_at`). Refitting must replace all of the first and
 * preserve all of the second. Naming the owned keys is what lets
 * `mergeStats` do that without having to know what the annotations are.
 *
 * A key REMOVED from `buildStats` must stay in this list, or the stale value
 * it last wrote will survive every future refit as though it were current.
 */
const MEASURED_STATS_KEYS = [
  'r2',
  'adj_r2',
  'n',
  'rmse',
  'period_start',
  'period_end',
  'source',
  'specification',
  'holdout',
] as const;

/**
 * The fit's own description of itself. ONE definition, used by both the
 * generated SQL and the `--write` path.
 *
 * They used to build this separately and had drifted: `--sql` emitted
 * `holdout` and `--write` did not, and `--sql` rounded while `--write` stored
 * raw floats. Harmless while each replaced `stats` wholesale — but once the
 * write started merging (to stop it deleting 0006's annotations), the
 * divergence turned into a real defect: a `--write` refit kept the previous
 * `--sql` run's `holdout` and reattributed another fit's backtest MAE to the
 * new coefficients. Two paths that write the same row must build it the same
 * way, so there is now only one place to change.
 */
function buildStats(r: LocationResult): ModelFitStats {
  return {
    r2: Number(r.final.r2.toFixed(6)),
    adj_r2: Number(r.final.adjR2.toFixed(6)),
    n: r.final.n,
    rmse: Number(r.final.rmse.toFixed(4)),
    period_start: r.firstDate,
    period_end: r.lastDate,
    source: 'nafas-pm25 x era5-weather 2022-2023',
    specification: 'lagged_pm25 + same_day_wind',
    holdout: Object.fromEntries(
      r.skill.map((s) => [
        `h${s.horizon}`,
        { hybrid: Number(s.hybrid.toFixed(2)), persistence: Number(s.persistence.toFixed(2)) },
      ]),
    ),
  };
}

/** The fitted slopes, by predictor name. Read by name in predict.ts, never by position. */
function buildCoef(r: LocationResult): ModelCoefficientMap {
  return {
    pm25_lag: Number(r.final.b1.toFixed(6)),
    wind_speed_avg_ms: Number(r.final.b2.toFixed(6)),
  };
}

/**
 * Fresh measurements over an existing row's `stats`, keeping foreign
 * annotations and dropping every measured key the old row carried.
 *
 * Exported for tests: the failure this prevents is invisible in the output
 * (every value looks plausible) and only appears months later as a fit
 * described by another fit's numbers.
 */
export function mergeStats(
  existing: Record<string, Json | undefined> | null | undefined,
  fresh: ModelFitStats,
): ModelFitStats {
  const kept: Record<string, Json | undefined> = {};
  for (const [k, v] of Object.entries(existing ?? {})) {
    if (!(MEASURED_STATS_KEYS as readonly string[]).includes(k)) kept[k] = v;
  }
  // `fresh` last, so it wins on any key that survived the filter.
  return { ...kept, ...fresh };
}

/** MEASURED_STATS_KEYS as a Postgres text[] literal, for the jsonb `-` below. */
function sqlKeyArray(): string {
  return `array[${MEASURED_STATS_KEYS.map((k) => `'${k}'`).join(', ')}]::text[]`;
}

function toSql(results: LocationResult[]): string {
  const rows = results
    .filter((r) => r.passes)
    .map((r) => {
      const coef = JSON.stringify(buildCoef(r));
      const stats = JSON.stringify(buildStats(r));
      return `  ('${r.loc.slug}', ${COEFFICIENT_VERSION}, ${r.final.intercept.toFixed(6)}, '${coef}'::jsonb, '${stats}'::jsonb)`;
    });

  if (rows.length === 0) return '-- nothing passed the gates; no coefficients to seed\n';

  return `-- Generated by scripts/calibrate/fit-wind-model.ts on ${new Date().toISOString().slice(0, 10)}
-- Nafas PM2.5 x ERA5 weather, 2022-2023. Idempotent: re-running upserts version 1.
insert into public.model_coefficients (location_id, model, version, intercept, coef, stats, is_active)
select l.id, 'wind_regression', v.version, v.intercept, v.coef, v.stats, true
from (values
${rows.join(',\n')}
) as v (location_slug, version, intercept, coef, stats)
join public.locations l on l.slug = v.location_slug
on conflict (location_id, model, version) do update set
  intercept = excluded.intercept,
  coef      = excluded.coef,
  -- MERGE, not replace, and drop this script's own keys before merging.
  --
  -- \`stats\` carries two different kinds of thing: what this fit measured
  -- (r2, n, rmse, holdout...), and annotations other migrations stamp on
  -- afterwards -- 0006 writes \`station_mix_changed_at\` here expressly so the
  -- note "this location's ground truth changed instrument mix on date X"
  -- travels with the model instead of living only in a migration nobody
  -- re-reads.
  --
  -- \`stats = excluded.stats\` deleted the annotations: a refit is not evidence
  -- the discontinuity did not happen. Applying 0007 wiped the stamp off both
  -- jakarta-central and bsd exactly that way.
  --
  -- A plain \`||\` fixes that but introduces the mirror-image fault: any
  -- measured key this script STOPS emitting would keep its stale value
  -- forever, silently described as current. Subtracting the owned keys first
  -- means a refit fully replaces its own measurements and preserves
  -- everything else -- the same contract as mergeStats() on the --write path.
  stats     = (coalesce(model_coefficients.stats, '{}'::jsonb) - ${sqlKeyArray()}) || excluded.stats,
  is_active = excluded.is_active;
`;
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Locations with a 2022-2023 Nafas archive to fit on.
 *
 * The archive was always per-city -- ten CSVs covering DKI's five
 * administrative cities plus five satellites -- but until the Jakarta
 * decomposition (0007) the app had one location for the whole of Jakarta, so
 * eight of the ten files went unused. Every Jabodetabek location now maps to
 * exactly one file, at the same grain the file was collected at.
 *
 * Two consequences worth being deliberate about:
 *
 *  - Nafas's per-city series is a mean over that city's sensors, while the
 *    live `daily_aq` for these locations is a mean over the one or two feeds
 *    seeded in 0007. Same city, different instrument mix -- so the fit and the
 *    thing it is scored against are not the same measurement, and the gates
 *    below (and /models in production) are what keep that honest.
 *  - `nafas_east_jakarta.csv` is deliberately absent. There is no
 *    `jakarta-east` location, because Jakarta Timur has no live feed; fitting
 *    coefficients for a location that can never supply `pm25_lag` at inference
 *    would produce a model that cannot run. The file stays staged for the day
 *    a feed appears.
 *
 * The remaining unused satellites -- bogor, depok, tangerang -- have archives
 * but no location, which is the reverse problem and a much easier one.
 */
const TRAINABLE: { slug: LocationSlug; file: string }[] = [
  { slug: 'jakarta-central', file: 'nafas_central_jakarta.csv' },
  { slug: 'jakarta-north', file: 'nafas_north_jakarta.csv' },
  { slug: 'jakarta-south', file: 'nafas_south_jakarta.csv' },
  { slug: 'jakarta-west', file: 'nafas_west_jakarta.csv' },
  { slug: 'bsd', file: 'nafas_south_tangerang.csv' },
  { slug: 'bekasi', file: 'nafas_bekasi.csv' },
];

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const wantSql = argv.includes('--sql');
  const wantWrite = argv.includes('--write');
  const refresh = argv.includes('--refresh');

  const results: LocationResult[] = [];

  for (const { slug, file } of TRAINABLE) {
    const loc = LOCATIONS.find((l) => l.slug === slug);
    if (!loc) throw new Error(`Unknown location slug ${slug}`);

    const pm = loadDailyPm25(file);
    const wx = await loadEra5(loc, refresh);
    const dates = [...pm.keys()].sort();
    const cut = Math.floor(dates.length * TRAIN_FRACTION);
    const trainDates = new Set(dates.slice(0, cut));
    const testDates = dates.slice(cut);

    const pmTrain = new Map([...pm].filter(([d]) => trainDates.has(d)));

    const trainHybrid = olsFit2(buildHybridRows(pmTrain, wx, 1));
    const trainWeatherOnly = olsFit2(buildWeatherOnlyRows(pmTrain, wx));
    const final = olsFit2(buildHybridRows(pm, wx, 1));
    if (!trainHybrid || !trainWeatherOnly || !final) {
      console.error(`${slug}: could not fit`);
      continue;
    }

    const trainMean = [...pmTrain.values()].reduce((a, b) => a + b, 0) / pmTrain.size;

    const skill: HorizonSkill[] = HORIZONS.map((horizon) => {
      const H: { p: number; a: number }[] = [];
      const W: { p: number; a: number }[] = [];
      const P: { p: number; a: number }[] = [];
      const C: { p: number; a: number }[] = [];
      for (const target of testDates) {
        const actual = pm.get(target);
        if (actual === undefined) continue;
        // What is known when the forecast is issued, `horizon` days earlier.
        const lastKnown = pm.get(shiftDate(target, -horizon));
        const w = wx.get(target);
        if (lastKnown !== undefined) P.push({ p: lastKnown, a: actual });
        if (w) {
          const wo = olsPredict(
            { intercept: trainWeatherOnly.intercept, b1: trainWeatherOnly.b1, b2: trainWeatherOnly.b2 },
            w.windAvgMs,
            w.tempAvgC,
          );
          if (wo !== null) W.push({ p: Math.max(0, wo), a: actual });
          if (lastKnown !== undefined) {
            const hy = olsPredict(
              { intercept: trainHybrid.intercept, b1: trainHybrid.b1, b2: trainHybrid.b2 },
              lastKnown,
              w.windAvgMs,
            );
            if (hy !== null) H.push({ p: Math.max(0, hy), a: actual });
          }
        }
        C.push({ p: trainMean, a: actual });
      }
      return {
        horizon,
        hybrid: mae(H),
        weatherOnly: mae(W),
        persistence: mae(P),
        climatology: mae(C),
      };
    });

    // Gates ask "is this model worth storing?", not "is it always the best?".
    //
    // Production writes all three models every day and `model_accuracy` ranks
    // them per location AND per horizon, so the headline already picks whichever
    // actually wins. A model that loses at h=1 but wins at h=3 is therefore
    // still worth shipping — it will simply be selected only where it earns it.
    // What would NOT be worth shipping is a model that is beaten by the free
    // benchmarks everywhere, or one whose wind term contradicts the physics.
    const windNegative = final.b2 < 0;
    const windSignificant = Math.abs(final.terms.b2.tStat ?? 0) > 3;
    const beatsClimatology = skill.every((s) => s.hybrid < s.climatology);
    const winsSomewhere = skill.some((s) => s.hybrid < s.persistence);
    const winningHorizons = skill.filter((s) => s.hybrid < s.persistence).map((s) => `h${s.horizon}`);
    const gates = [
      `${windNegative ? '✓' : '✗'} wind coefficient negative (${f(final.b2, 2)})`,
      `${windSignificant ? '✓' : '✗'} wind coefficient significant (|t|=${f(Math.abs(final.terms.b2.tStat ?? 0), 1)} > 3)`,
      `${beatsClimatology ? '✓' : '✗'} beats climatology at every horizon`,
      `${winsSomewhere ? '✓' : '✗'} beats persistence somewhere (${winningHorizons.join(', ') || 'nowhere'})`,
      `  persistence is strong close in (h=1: ${f(skill[0].persistence, 2)} vs hybrid ${f(skill[0].hybrid, 2)}) and`,
      `  decays with horizon (h=3: ${f(skill[2].persistence, 2)} vs ${f(skill[2].hybrid, 2)}) — the per-horizon`,
      `  winner selection in production is what turns that into an advantage.`,
    ];

    results.push({
      loc,
      trainHybrid,
      trainWeatherOnly,
      final,
      skill,
      firstDate: dates[0],
      lastDate: dates[dates.length - 1],
      trainRange: `${dates[0]}..${dates[cut - 1]} (${cut})`,
      testRange: `${testDates[0]}..${testDates[testDates.length - 1]} (${testDates.length})`,
      passes: windNegative && windSignificant && beatsClimatology && winsSomewhere,
      gates,
    });
  }

  results.forEach(report);

  console.log(`\n${'='.repeat(78)}\nSUMMARY\n${'='.repeat(78)}`);
  for (const r of results) {
    console.log(
      `  ${r.loc.slug.padEnd(18)} b_wind=${f(r.final.b2, 2).padStart(7)}  R²=${f(r.final.r2, 3)}  ` +
        `h1/h2/h3 MAE ${r.skill.map((s) => f(s.hybrid, 1)).join('/')}  ${r.passes ? 'PASS' : 'FAIL'}`,
    );
  }
  console.log(
    `\n  no PM2.5 archive — cams + persistence until ~90 days accumulate:\n    ${LOCATIONS.filter(
      (l) => !TRAINABLE.some((t) => t.slug === l.slug),
    )
      .map((l) => l.slug)
      .join(', ')}`,
  );
  console.log(
    '\n  CAVEAT: this backtest feeds the models ERA5 actuals for the target day, i.e. a\n' +
      '  perfect wind forecast. Live skill will be lower by Open-Meteo’s wind error, and\n' +
      '  the gap grows with horizon. /models measures the real thing.',
  );

  if (wantSql || wantWrite) {
    console.log(`\n${'='.repeat(78)}\nSEED SQL\n${'='.repeat(78)}\n${toSql(results)}`);
  }

  if (wantWrite) {
    const seedable = results.filter((r) => r.passes);
    if (seedable.length === 0) {
      console.error('Nothing passed the gates — refusing to write.');
      process.exitCode = 1;
      return;
    }
    const { getServiceClient } = await import('../../src/lib/db');
    const db = getServiceClient();
    // `.returns<>()` pins the row shape: the hand-written Database type in
    // src/lib/types.ts cannot infer it through the select-string parser, and
    // without it the result degrades to `never`.
    const { data: locs, error } = await db
      .from('locations')
      .select('id, slug')
      .returns<{ id: number; slug: LocationSlug }[]>();
    if (error) throw new Error(`Could not read locations: ${error.message}`);
    const idBySlug = new Map((locs ?? []).map((l) => [l.slug, l.id]));

    // Existing `stats`, so annotations stamped on by other migrations survive
    // the refit. Same reasoning as the `||` in toSql(): PostgREST's upsert
    // replaces the whole row, so without this read the write would delete
    // 0006's `station_mix_changed_at` the way applying 0007 did.
    const { data: existing, error: existingError } = await db
      .from('model_coefficients')
      .select('location_id, version, stats')
      .eq('model', 'wind_regression')
      .returns<{ location_id: number; version: number; stats: ModelFitStats | null }[]>();
    if (existingError) throw new Error(`Could not read model_coefficients: ${existingError.message}`);
    const statsByKey = new Map(
      (existing ?? []).map((e) => [`${e.location_id}:${e.version}`, e.stats ?? {}]),
    );

    for (const r of seedable) {
      const location_id = idBySlug.get(r.loc.slug);
      if (location_id === undefined) {
        console.error(`  ${r.loc.slug}: absent from locations — apply 0004_seed.sql first`);
        continue;
      }
      const row: ModelCoefficientsInsert = {
        location_id,
        model: 'wind_regression',
        version: COEFFICIENT_VERSION,
        intercept: Number(r.final.intercept.toFixed(6)),
        coef: buildCoef(r),
        stats: mergeStats(statsByKey.get(`${location_id}:${COEFFICIENT_VERSION}`), buildStats(r)),
        is_active: true,
      };
      const { error: upsertError } = await db
        .from('model_coefficients')
        .upsert(row as never, { onConflict: 'location_id,model,version' });
      console.log(upsertError ? `  ${r.loc.slug}: FAILED — ${upsertError.message}` : `  ${r.loc.slug}: written`);
    }
  }
}

/**
 * Run the fit only when this file IS the command, not when it is imported.
 *
 * `mergeStats` is exported for tests/calibrate-stats.test.ts, and a bare
 * `main()` at module scope made importing it run the whole calibration as a
 * side effect: reading the Nafas archive, pulling ERA5, printing the report.
 * Locally that merely made `npm test` do a hidden refit. In CI it is worse --
 * `data/historical/` is gitignored and therefore absent, so main() throws,
 * this catch sets `process.exitCode = 1`, and vitest exits non-zero with every
 * test passing. Whether it lands before vitest finishes is a race, which is
 * the nastiest version of that bug: a green suite that fails intermittently
 * for a reason nothing in the test output mentions.
 */
const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
