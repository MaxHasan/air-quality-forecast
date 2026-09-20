import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ACTIVITY_THRESHOLDS,
  VERDICT_PRESENTATION,
  allVerdicts,
  thresholdFor,
  verdictFor,
} from '@/lib/thresholds';
import { ALL_STATIONS, LOCATIONS, MIN_HOURS_FOR_SCORING } from '@/lib/stations';
import { MODEL_FALLBACK_ORDER } from '@/lib/types';
import { defaultMinDays } from '@/lib/rolling';
// Importing a script is safe here: fit-wind-model.ts guards its main() behind
// an entrypoint check precisely so importing it does not run a calibration as
// a side effect. See the note at the bottom of that file.
import { SHIPPED_LAG_SPEC, TRAINABLE } from '../scripts/calibrate/fit-wind-model';

describe('verdictFor', () => {
  it('treats bounds as inclusive', () => {
    expect(verdictFor('newborn_walk', 15)).toBe('go');
    expect(verdictFor('newborn_walk', 15.01)).toBe('caution');
    expect(verdictFor('newborn_walk', 25)).toBe('caution');
    expect(verdictFor('newborn_walk', 25.01)).toBe('avoid');
  });

  it('ranks the three activities strictest-first at a shared concentration', () => {
    // 30 µg/m³ is a typical Jakarta day: too dirty for the stroller, marginal for a
    // run, acceptable for a swim. If this ever inverts, the config is wrong.
    expect(verdictFor('newborn_walk', 30)).toBe('avoid');
    expect(verdictFor('running', 30)).toBe('caution');
    expect(verdictFor('swimming', 30)).toBe('go');
  });

  it('calls clean air good for everything', () => {
    for (const t of ACTIVITY_THRESHOLDS) expect(verdictFor(t.key, 8)).toBe('go');
  });

  it('calls the bad days bad for everything', () => {
    // Jakarta's CAMS reading during development was ~148 µg/m³.
    for (const t of ACTIVITY_THRESHOLDS) expect(verdictFor(t.key, 148)).toBe('avoid');
  });

  it('returns null — never a reassuring "go" — for missing or invalid data', () => {
    expect(verdictFor('running', null)).toBeNull();
    expect(verdictFor('running', undefined)).toBeNull();
    expect(verdictFor('running', Number.NaN)).toBeNull();
    expect(verdictFor('running', -1)).toBeNull();
  });

  it('is monotonic: dirtier air never yields a better verdict', () => {
    const rank = { go: 0, caution: 1, avoid: 2 } as const;
    for (const t of ACTIVITY_THRESHOLDS) {
      let prev = -1;
      for (let pm = 0; pm <= 200; pm += 0.5) {
        const v = verdictFor(t.key, pm)!;
        expect(rank[v]).toBeGreaterThanOrEqual(prev);
        prev = rank[v];
      }
    }
  });
});

describe('threshold config', () => {
  it('is internally ordered go < caution for every activity', () => {
    for (const t of ACTIVITY_THRESHOLDS) {
      expect(t.goMax).toBeLessThan(t.cautionMax);
      expect(t.goMax).toBeGreaterThan(0);
    }
  });

  it('is listed strictest-first', () => {
    for (let i = 1; i < ACTIVITY_THRESHOLDS.length; i += 1) {
      expect(ACTIVITY_THRESHOLDS[i].goMax).toBeGreaterThanOrEqual(ACTIVITY_THRESHOLDS[i - 1].goMax);
    }
  });

  it('pins the newborn tier to the WHO 24-hour guideline', () => {
    expect(thresholdFor('newborn_walk').goMax).toBe(15);
  });

  it('documents a rationale for each tier', () => {
    for (const t of ACTIVITY_THRESHOLDS) expect(t.rationale.length).toBeGreaterThan(40);
  });

  it('returns one verdict per activity from allVerdicts', () => {
    const all = allVerdicts(30);
    expect(all).toHaveLength(ACTIVITY_THRESHOLDS.length);
    expect(all.map((a) => a.activity)).toEqual(ACTIVITY_THRESHOLDS.map((t) => t.key));
  });

  it('has presentation metadata for all three verdicts', () => {
    for (const v of ['go', 'caution', 'avoid'] as const) {
      expect(VERDICT_PRESENTATION[v].label.length).toBeGreaterThan(0);
    }
  });
});

/**
 * stations.ts is a hand-maintained mirror of the seed migrations (0004 + 0006).
 * These tests are the thing that stops the two drifting apart silently — a
 * mismatch would mean the weather pull and the PM2.5 rollup were keyed to
 * different places.
 */
describe('stations.ts agrees with the seed migrations', () => {
  // Locations and stations are seeded across several migrations -- 0004 (waqi +
  // datagovsg), 0006 (airgradient), 0007 (the Jakarta regions + bekasi) -- and
  // the mirror must agree with their union.
  //
  // Read by globbing the directory rather than by naming the files. The named
  // list went stale the moment 0007 landed: `jakarta-north` was in stations.ts
  // and in a migration, but not in either of the two files this test happened
  // to read, so a correct registry failed and the fix was to edit the test. A
  // sync check that has to be updated by hand every time the thing it guards
  // changes is a sync check that will eventually be updated wrongly.
  const migrationsDir = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));
  const seed = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(join(migrationsDir, f), 'utf8'))
    .join('\n');

  it('seeds every location slug, with the same timezone', () => {
    for (const loc of LOCATIONS) {
      const row = new RegExp(`'${loc.slug}'[^\\n]*`).exec(seed);
      expect(row, `slug ${loc.slug} missing from seed`).not.toBeNull();
      expect(seed).toContain(`'${loc.timezone}'`);
    }
  });

  it('seeds every verified station id', () => {
    for (const s of ALL_STATIONS) {
      expect(seed, `station ${s.sourceStationId} missing from seed`).toContain(`'${s.sourceStationId}'`);
    }
  });

  it('gives Bali WITA, not WIB', () => {
    const bali = LOCATIONS.find((l) => l.slug === 'bali-denpasar')!;
    expect(bali.timezone).toBe('Asia/Makassar');
  });

  it('has unique slugs and unique (source, id) station pairs', () => {
    const slugs = LOCATIONS.map((l) => l.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    const keys = ALL_STATIONS.map((s) => `${s.source}:${s.sourceStationId}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('maps every station to a known location', () => {
    const slugs = new Set(LOCATIONS.map((l) => l.slug));
    for (const s of ALL_STATIONS) {
      expect(slugs.has(s.locationSlug)).toBe(true);
    }
  });

  it('gives every location plausible coordinates for its country', () => {
    for (const l of LOCATIONS) {
      if (l.country === 'ID') {
        expect(l.lat).toBeLessThan(0); // southern hemisphere
        expect(l.lon).toBeGreaterThan(95);
        expect(l.lon).toBeLessThan(141);
      } else {
        expect(l.lat).toBeGreaterThan(1);
        expect(l.lat).toBeLessThan(1.5);
        expect(l.lon).toBeGreaterThan(103);
        expect(l.lon).toBeLessThan(104.2);
      }
    }
  });
});

/**
 * Drift checks between the shipped TypeScript constants and the migration SQL
 * Max applies by hand in the Supabase SQL editor.
 *
 * These two artefacts cannot import from each other, so nothing but a test
 * keeps them in step — and both failure modes are silent rather than loud. A
 * model in `MODEL_FALLBACK_ORDER` but missing from 0008's CHECK fails the
 * nightly upsert, which throws and loses EVERY model's predictions for that
 * run (scripts/lib/db.ts). A lag constant that disagrees with the seeded
 * `stats` is the train/inference mismatch this branch removes, coming back
 * through the back door.
 */
describe('migration SQL agrees with the shipped constants', () => {
  const migrationsDir = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));
  const read = (file: string): string => readFileSync(join(migrationsDir, file), 'utf8');

  /**
   * The file with `-- …` line comments removed.
   *
   * Needed for the negative assertions below. These migrations document the
   * wrong way to do a thing right above the right way — 0009's header spells
   * out `stats = excluded.stats` in order to explain why it must not be used —
   * so a naive search finds the warning and reports it as the fault.
   */
  const readStatements = (file: string): string =>
    read(file)
      .split('\n')
      .filter((line) => !/^\s*--/.test(line))
      .join('\n');

  it('0008’s predictions.model CHECK lists exactly MODEL_FALLBACK_ORDER', () => {
    const sql = read('0008_rolling_mean_model.sql');
    const match = /add constraint predictions_model_check\s*\n?\s*check \(model in \(([^)]*)\)\)/i.exec(sql);
    expect(match, 'could not find the predictions.model CHECK in 0008').not.toBeNull();

    const inSql = (match as RegExpExecArray)[1]
      .split(',')
      .map((s) => s.trim().replace(/^'|'$/g, ''))
      .filter(Boolean);

    // Exactly the same members, caught in BOTH directions. Sorted so the
    // CHECK's order (arbitrary) is not confused with MODEL_FALLBACK_ORDER's
    // (meaningful — it is the cold-start preference and the render order).
    expect([...inSql].sort()).toEqual([...MODEL_FALLBACK_ORDER].sort());
  });

  /**
   * Every migration that seeds `model_coefficients`, found rather than listed.
   *
   * 0009 seeded two locations and 0010 the other four, and the gap between
   * them was not a typo — it was a hardcoded seed list that did not grow when
   * jakarta-regions merged four more trainable locations. A test naming its
   * migrations by hand has the same failure mode as the migration did, so
   * these are discovered instead, and the coverage test below asks the
   * question the file names cannot: is every trainable location seeded at all?
   */
  const seedMigrations = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => readStatements(f).includes('insert into public.model_coefficients'))
    .sort();

  /** The slugs a seed migration's `values (...)` list actually covers. */
  const seededSlugs = (file: string): string[] =>
    [...readStatements(file).matchAll(/\(\s*'([a-z0-9-]+)'\s*,\s*2\s*,/g)].map((m) => m[1]);

  it('finds the seed migrations at all', () => {
    // Guards the discovery above: if the insert statement is ever reworded,
    // every test in this block would silently pass over an empty list.
    expect(seedMigrations.length).toBeGreaterThan(0);
  });

  it.each(seedMigrations)('%s seeds lag literals equal to the shipped fit spec', (file) => {
    const sql = read(file);

    const windows = [...sql.matchAll(/"lag_window_days":(\d+)/g)].map((m) => Number(m[1]));
    const minHours = [...sql.matchAll(/"lag_min_hours":(\d+)/g)].map((m) => Number(m[1]));
    const minDays = [...sql.matchAll(/"lag_min_days":(\d+)/g)].map((m) => Number(m[1]));

    // One of each per seeded row. A row missing one is a row predict.ts
    // refuses at runtime with no test having noticed.
    const rows = seededSlugs(file).length;
    expect(rows).toBeGreaterThan(0);
    expect(windows).toHaveLength(rows);
    expect(minHours).toHaveLength(rows);
    expect(minDays).toHaveLength(rows);

    for (const w of windows) expect(w).toBe(SHIPPED_LAG_SPEC.windowDays);
    for (const h of minHours) expect(h).toBe(SHIPPED_LAG_SPEC.minHours);
    for (const d of minDays) expect(d).toBe(SHIPPED_LAG_SPEC.minDays);

    // minHours is MIN_HOURS_FOR_SCORING, not an independent number: the bar a
    // day must clear to be an input is the same bar it must clear to score a
    // model against.
    expect(SHIPPED_LAG_SPEC.minHours).toBe(MIN_HOURS_FOR_SCORING);
    expect(SHIPPED_LAG_SPEC.minDays).toBe(defaultMinDays(SHIPPED_LAG_SPEC.windowDays));
  });

  it.each(seedMigrations)('%s seeds version 2 and declares the rolling specification', (file) => {
    const sql = read(file);
    // Every seeded row must say which specification it is: that string is how
    // a reader tells a v1 row from a v2 one months later, and it is what
    // resolveLagSpec's refusal is protecting.
    const specs = [...sql.matchAll(/"specification":"([^"]+)"/g)].map((m) => m[1]);
    expect(specs).toHaveLength(seededSlugs(file).length);
    for (const s of specs) expect(s).toBe('rolling_pm25_lag + same_day_wind');

    // The deactivate-then-insert order is forced by a non-deferred partial
    // unique index. If an edit ever reverses it the migration aborts on a live
    // database; this catches it first.
    expect(sql.indexOf('set is_active = false')).toBeLessThan(
      sql.indexOf('insert into public.model_coefficients'),
    );
  });

  it.each(seedMigrations)('%s merges stats on conflict instead of replacing them', (file) => {
    const sql = readStatements(file);
    // `stats = excluded.stats` would wipe station_mix_changed_at off exactly
    // the two locations 0006 stamped it onto. Applying 0007 did that once.
    expect(sql).not.toMatch(/stats\s*=\s*excluded\.stats/);
    expect(sql).toMatch(/stats\s*=\s*\(coalesce\(model_coefficients\.stats/);
    expect(sql).toContain("- array['r2'");
  });

  it('carries 0006’s station-mix annotation onto the active version 2 rows', () => {
    // The assertion above is about the `on conflict ... do update` clause, and
    // it passed all along while the thing it describes was not happening: 0009
    // and 0010 INSERTED version 2 for the first time, so there was no conflict,
    // no merge, and the annotation stayed on the version 1 row they had just
    // deactivated. Checking the merge FORM cannot see that the insert path
    // inherits nothing — so check the outcome instead. Some migration must
    // write these keys onto version 2.
    const writesOntoV2 = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .some((f) => {
        const sql = readStatements(f);
        return (
          sql.includes('station_mix_note') &&
          /update\s+public\.model_coefficients/i.test(sql) &&
          /version\s*=\s*2/.test(sql)
        );
      });

    expect(
      writesOntoV2,
      'no migration carries station_mix_changed_at / station_mix_note onto the active v2 ' +
        'coefficients — 0006’s annotation is stranded on the deactivated v1 rows',
    ).toBe(true);
  });

  it('seeds every trainable location exactly once across all seed migrations', () => {
    const seeded = seedMigrations.flatMap(seededSlugs);

    // The bug this test exists for: 0009 shipped seeding two of six, so
    // jakarta-north, jakarta-south, jakarta-west and bekasi kept their v1
    // coefficients — which predict.ts then refused, leaving them with no wind
    // forecast at all. Nothing failed; the model just went quiet.
    for (const { slug } of TRAINABLE) {
      expect(seeded, `${slug} is trainable but no migration seeds v2 coefficients for it`).toContain(slug);
    }

    // And the reverse: a slug seeded twice means two migrations both claim to
    // set the active row, and which one wins depends on apply order.
    expect([...new Set(seeded)].sort()).toEqual([...seeded].sort());
  });

  it('no migration widens model_coefficients.model to rolling_mean', () => {
    // rolling_mean has no fitted coefficients — that is exactly what lets it
    // run for Bali and Singapore, where there is nothing to fit on.
    for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'))) {
      const sql = readStatements(file);
      for (const block of sql.match(/model_coefficients[\s\S]{0,400}?check \(model in \([^)]*\)/gi) ?? []) {
        expect(block, `${file} must not add rolling_mean to model_coefficients`).not.toContain('rolling_mean');
      }
    }
  });
});
