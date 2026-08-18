import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ACTIVITY_THRESHOLDS,
  VERDICT_PRESENTATION,
  allVerdicts,
  thresholdFor,
  verdictFor,
} from '@/lib/thresholds';
import { ALL_STATIONS, LOCATIONS } from '@/lib/stations';

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
 * stations.ts is a hand-maintained mirror of the seed migration. These tests are
 * the thing that stops the two drifting apart silently — a mismatch would mean
 * the weather pull and the PM2.5 rollup were keyed to different places.
 */
describe('stations.ts agrees with 0004_seed.sql', () => {
  // Stations are seeded across two migrations: 0004 (waqi + datagovsg) and
  // 0006 (airgradient). The mirror must agree with their union.
  const seed =
    readFileSync(fileURLToPath(new URL('../supabase/migrations/0004_seed.sql', import.meta.url)), 'utf8') +
    readFileSync(fileURLToPath(new URL('../supabase/migrations/0006_airgradient.sql', import.meta.url)), 'utf8');

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
