/**
 * aqi.ts — US-EPA PM2.5 AQI ⇄ concentration conversion.
 *
 * Why this file gates data correctness: WAQI's `iaqi.pm25.v` is an **AQI
 * sub-index**, not µg/m³. Reading 155 as a concentration when it is really an
 * index (≈ 64 µg/m³ on the pre-2024 table) would poison every rollup, every
 * regression fit and every verdict. Everything Indonesian passes through here.
 *
 * Two breakpoint tables exist and they disagree in exactly the range this app
 * cares about:
 *
 *   AQI 50  ->  12.0 µg/m³ (pre-2024)   vs   9.0 µg/m³ (2024 revision)
 *   AQI 200 -> 150.4 µg/m³ (pre-2024)   vs  125.4 µg/m³ (2024 revision)
 *
 * Both are shipped as data. Which one WAQI currently applies is an empirical
 * question — see DEFAULT_PM25_BREAKPOINTS below.
 *
 * EPA arithmetic conventions, followed exactly:
 *   - concentrations are truncated (not rounded) to one decimal before lookup;
 *   - the index is rounded to the nearest integer;
 *   - conversion is piecewise-linear within a breakpoint band:
 *
 *       I = (I_hi - I_lo) / (C_hi - C_lo) * (C - C_lo) + I_lo
 */

import type { AqiTableId } from './types';

/* -------------------------------------------------------------------------- */
/* Categories                                                                 */
/* -------------------------------------------------------------------------- */

export type AqiCategoryKey =
  | 'good'
  | 'moderate'
  | 'unhealthy_sensitive'
  | 'unhealthy'
  | 'very_unhealthy'
  | 'hazardous';

export interface AqiCategory {
  key: AqiCategoryKey;
  label: string;
  /** Inclusive AQI bounds. */
  aqiLow: number;
  aqiHigh: number;
  /** Official EPA colour, for charts and badges. */
  color: string;
  /** Readable foreground on `color` — yellow/green need dark text. */
  onColor: string;
}

/** The six EPA categories, ascending. Identical across both breakpoint tables. */
export const AQI_CATEGORIES: readonly AqiCategory[] = [
  { key: 'good', label: 'Good', aqiLow: 0, aqiHigh: 50, color: '#00e400', onColor: '#0b2a0b' },
  { key: 'moderate', label: 'Moderate', aqiLow: 51, aqiHigh: 100, color: '#ffff00', onColor: '#332f00' },
  {
    key: 'unhealthy_sensitive',
    label: 'Unhealthy for Sensitive Groups',
    aqiLow: 101,
    aqiHigh: 150,
    color: '#ff7e00',
    onColor: '#331900',
  },
  { key: 'unhealthy', label: 'Unhealthy', aqiLow: 151, aqiHigh: 200, color: '#ff0000', onColor: '#ffffff' },
  { key: 'very_unhealthy', label: 'Very Unhealthy', aqiLow: 201, aqiHigh: 300, color: '#8f3f97', onColor: '#ffffff' },
  { key: 'hazardous', label: 'Hazardous', aqiLow: 301, aqiHigh: 500, color: '#7e0023', onColor: '#ffffff' },
] as const;

/* -------------------------------------------------------------------------- */
/* Breakpoint tables                                                          */
/* -------------------------------------------------------------------------- */

export interface AqiBreakpoint {
  /** Inclusive concentration bounds, µg/m³, truncated to 1 dp. */
  cLow: number;
  cHigh: number;
  /** Inclusive index bounds. */
  iLow: number;
  iHigh: number;
  category: AqiCategoryKey;
}

export interface AqiBreakpointTable {
  id: AqiTableId;
  label: string;
  /** Ascending, contiguous after 1-dp truncation (…12.0 | 12.1…). */
  breakpoints: readonly AqiBreakpoint[];
}

/**
 * PM2.5 24-hour breakpoints in force from 1999 until the May-2024 revision.
 * Still what most third-party AQI displays use.
 */
export const EPA_PM25_BREAKPOINTS_PRE_2024: AqiBreakpointTable = {
  id: 'epa-pre-2024',
  label: 'US-EPA PM2.5 (pre-2024, Good ≤ 12.0)',
  breakpoints: [
    { cLow: 0.0, cHigh: 12.0, iLow: 0, iHigh: 50, category: 'good' },
    { cLow: 12.1, cHigh: 35.4, iLow: 51, iHigh: 100, category: 'moderate' },
    { cLow: 35.5, cHigh: 55.4, iLow: 101, iHigh: 150, category: 'unhealthy_sensitive' },
    { cLow: 55.5, cHigh: 150.4, iLow: 151, iHigh: 200, category: 'unhealthy' },
    { cLow: 150.5, cHigh: 250.4, iLow: 201, iHigh: 300, category: 'very_unhealthy' },
    { cLow: 250.5, cHigh: 350.4, iLow: 301, iHigh: 400, category: 'hazardous' },
    { cLow: 350.5, cHigh: 500.4, iLow: 401, iHigh: 500, category: 'hazardous' },
  ],
} as const;

/**
 * PM2.5 24-hour breakpoints from the May-2024 revision, which followed the
 * tightened annual PM2.5 NAAQS (12 → 9 µg/m³). Note the top of the table: EPA
 * collapsed the old 301–400 / 401–500 bands into a single 301–500 band, so this
 * table has six rows to the old table's seven.
 */
export const EPA_PM25_BREAKPOINTS_2024: AqiBreakpointTable = {
  id: 'epa-2024',
  label: 'US-EPA PM2.5 (May-2024 revision, Good ≤ 9.0)',
  breakpoints: [
    { cLow: 0.0, cHigh: 9.0, iLow: 0, iHigh: 50, category: 'good' },
    { cLow: 9.1, cHigh: 35.4, iLow: 51, iHigh: 100, category: 'moderate' },
    { cLow: 35.5, cHigh: 55.4, iLow: 101, iHigh: 150, category: 'unhealthy_sensitive' },
    { cLow: 55.5, cHigh: 125.4, iLow: 151, iHigh: 200, category: 'unhealthy' },
    { cLow: 125.5, cHigh: 225.4, iLow: 201, iHigh: 300, category: 'very_unhealthy' },
    { cLow: 225.5, cHigh: 325.4, iLow: 301, iHigh: 500, category: 'hazardous' },
  ],
} as const;

/** Lookup by the id stored in `aq_observations.aqi_table`. */
export const AQI_TABLES: Readonly<Record<AqiTableId, AqiBreakpointTable>> = {
  'epa-pre-2024': EPA_PM25_BREAKPOINTS_PRE_2024,
  'epa-2024': EPA_PM25_BREAKPOINTS_2024,
} as const;

/**
 * VERIFIED — the table WAQI publishes its `iaqi` sub-indices against.
 *
 * Established empirically on 2026-08-16 by co-locating Singapore, the one place
 * where the same air is reported both ways: WAQI carries the NEA feeds as AQI
 * sub-indices, and data.gov.sg publishes the same regional readings as native
 * µg/m³. Matching on WAQI's own `time.iso` (its feed runs ~1 hour behind
 * data.gov.sg, so aligning on wall-clock "now" compares different hours and
 * produces nonsense), for the 20:00 SGT hour:
 *
 *   region   truth µg/m³   WAQI AQI   pre-2024   2024 revision
 *   central      35           99         99          99          (degenerate)
 *   south        22           72         72          75
 *   north        26           80         80          82
 *   east         27           82         82          84
 *   west         23           74         74          77
 *
 * pre-2024 matched 5/5 exactly; the 2024 revision is excluded by 4 of the 5
 * (central cannot discriminate — both tables agree at 35 µg/m³).
 *
 * Re-run `npm run verify:aqi-table` if WAQI ever migrates to the 2024
 * breakpoints. Every stored row carries the table it was converted with in
 * `aq_observations.aqi_table`, so a migration would be a recoverable UPDATE
 * rather than a re-fetch.
 */
export const DEFAULT_PM25_BREAKPOINTS: AqiBreakpointTable = EPA_PM25_BREAKPOINTS_PRE_2024;

/** Convenience mirror of `DEFAULT_PM25_BREAKPOINTS.id` for DB writes. */
export const DEFAULT_AQI_TABLE_ID: AqiTableId = DEFAULT_PM25_BREAKPOINTS.id;

/* -------------------------------------------------------------------------- */
/* Conversion                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * EPA truncation to one decimal place (`12.19 -> 12.1`), with a tiny epsilon so
 * that binary-float artefacts (`12.1 * 10 === 120.99999999999999`) do not drop a
 * value into the band below.
 */
export function truncateToTenth(value: number): number {
  return Math.floor(value * 10 + 1e-9) / 10;
}

/**
 * Concentration (µg/m³) → AQI index.
 *
 * Returns `null` for non-finite, negative, or above-table values rather than
 * clamping: a PM2.5 above 500.4 µg/m³ means something is wrong upstream and
 * should surface as missing data, not as a confident "500".
 */
export function pm25ToAqi(pm25: number, table: AqiBreakpointTable = DEFAULT_PM25_BREAKPOINTS): number | null {
  if (!Number.isFinite(pm25) || pm25 < 0) return null;

  const c = truncateToTenth(pm25);
  const bp = table.breakpoints.find((b) => c >= b.cLow && c <= b.cHigh);
  if (!bp) return null;

  const aqi = ((bp.iHigh - bp.iLow) / (bp.cHigh - bp.cLow)) * (c - bp.cLow) + bp.iLow;
  return Math.round(aqi);
}

/**
 * AQI index → concentration (µg/m³), rounded to one decimal.
 *
 * This is the inversion the WAQI connector depends on. The index is rounded to
 * an integer first because that is the resolution WAQI publishes at; the result
 * is therefore quantised too (AQI 51 and 52 are ~0.5 µg/m³ apart at the low
 * end), which is a floor on this data source's precision.
 */
export function aqiToPm25(aqi: number, table: AqiBreakpointTable = DEFAULT_PM25_BREAKPOINTS): number | null {
  if (!Number.isFinite(aqi) || aqi < 0) return null;

  const i = Math.round(aqi);
  const bp = table.breakpoints.find((b) => i >= b.iLow && i <= b.iHigh);
  if (!bp) return null;

  const c = ((bp.cHigh - bp.cLow) / (bp.iHigh - bp.iLow)) * (i - bp.iLow) + bp.cLow;
  return Math.round(c * 10) / 10;
}

/** Category for an AQI index, or `null` if it falls outside 0–500. */
export function aqiCategory(aqi: number): AqiCategory | null {
  if (!Number.isFinite(aqi) || aqi < 0) return null;
  const i = Math.round(aqi);
  return AQI_CATEGORIES.find((cat) => i >= cat.aqiLow && i <= cat.aqiHigh) ?? null;
}

/**
 * Category for a concentration. Table-dependent: 10 µg/m³ is "Good" pre-2024
 * and "Moderate" under the 2024 revision.
 */
export function pm25Category(
  pm25: number,
  table: AqiBreakpointTable = DEFAULT_PM25_BREAKPOINTS,
): AqiCategory | null {
  const aqi = pm25ToAqi(pm25, table);
  return aqi === null ? null : aqiCategory(aqi);
}
