/**
 * datagovsg.ts — parsing Singapore's hourly regional PM2.5.
 *
 * Pure, like waqi.ts. The two feeds could hardly be more different in
 * temperament, and the differences drive the design of both connectors:
 *
 *   WAQI                              data.gov.sg v2
 *   one station, one current hour     five regions, a whole day at a time
 *   AQI sub-index (needs inverting)   native µg/m³
 *   errors hide inside HTTP 200       honest status codes (404 for no data)
 *
 * Because `?date=YYYY-MM-DD` returns every hour of that date, the connector
 * asks for today *and* yesterday on each run. That is the catch-up mechanism:
 * GitHub Actions cron drifts and occasionally skips, and a two-day trailing
 * window re-upserts anything a missed run would have lost. Idempotency on
 * `(station_id, observed_at)` is what makes re-asking free.
 *
 * Observed live on 2026-08-16:
 *   - `items` arrives newest-first, not oldest-first;
 *   - each item carries its own `updatedTimestamp`, and the same observation
 *     hour can appear more than once as NEA revises it;
 *   - success is `code: 0`; a date with no data is HTTP 404 with `code: 17`.
 */

import type { IsoTimestamp, SgRegionName } from '../../src/lib/types';
import { floorToHourUtc } from './time';

/** The five regions, in the order the seed lists them. */
export const SG_REGIONS: readonly SgRegionName[] = ['central', 'north', 'south', 'east', 'west'] as const;

const REGION_SET = new Set<string>(SG_REGIONS);

export interface SgReading {
  region: SgRegionName;
  /** UTC instant, floored to the hour. */
  observedAt: IsoTimestamp;
  /** Native µg/m³ — no AQI inversion involved. */
  pm25: number;
  /** NEA's own revision marker for this item, when present. */
  updatedAt: IsoTimestamp | null;
}

export type SgRejectReason = 'malformed' | 'api-error' | 'no-items';

export interface SgParsed {
  ok: true;
  readings: SgReading[];
  /** Diagnostics that belong in `ingestion_runs.meta`, not in an exception. */
  skipped: {
    /** Items with no usable timestamp. */
    badTimestamp: number;
    /** Region values that were absent, non-numeric or negative. */
    badValue: number;
    /** Duplicate (region, hour) pairs superseded by a newer revision. */
    superseded: number;
    /** Hours beyond the caller's `maxTime`. */
    future: number;
  };
}

export interface SgRejected {
  ok: false;
  reason: SgRejectReason;
  detail: string;
}

export type SgParseResult = SgParsed | SgRejected;

export interface SgParseOptions {
  /**
   * Drop hours after this instant. Defaults to open-ended. Passing `now`
   * prevents an upstream clock skew from writing observations dated in the
   * future, which would then sit in a daily bucket that has not happened yet.
   */
  maxTime?: Date;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * data.gov.sg stamps `+08:00` explicitly, so — unlike WAQI's `time.s` — these
 * are safe to hand to `Date`. The check is still made, because "the offset is
 * always there" is exactly the assumption that breaks silently.
 */
const ZONED_ISO = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

function parseZoned(value: unknown): Date | null {
  if (typeof value !== 'string' || !ZONED_ISO.test(value.trim())) return null;
  const d = new Date(value.trim());
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Parse one `?date=YYYY-MM-DD` response into flat per-region readings.
 *
 * Never throws and never gives up on the whole payload because one region in
 * one hour is bad: a single `null` reading from one sensor must not cost us the
 * other 119 readings in the response.
 */
export function parseDataGovSgPm25(payload: unknown, options: SgParseOptions = {}): SgParseResult {
  if (!isRecord(payload)) {
    return { ok: false, reason: 'malformed', detail: `expected an object, got ${typeof payload}` };
  }

  const code = payload.code;
  if (typeof code === 'number' && code !== 0) {
    const msg = typeof payload.errorMsg === 'string' && payload.errorMsg ? payload.errorMsg : 'unspecified';
    return { ok: false, reason: 'api-error', detail: `code ${code}: ${msg}` };
  }

  const data = isRecord(payload.data) ? payload.data : null;
  const items = data && Array.isArray(data.items) ? data.items : null;
  if (!items) {
    return { ok: false, reason: 'malformed', detail: '`data.items` is not an array' };
  }
  if (items.length === 0) {
    return { ok: false, reason: 'no-items', detail: 'response contained no items' };
  }

  const skipped = { badTimestamp: 0, badValue: 0, superseded: 0, future: 0 };
  const maxTimeMs = options.maxTime?.getTime() ?? Number.POSITIVE_INFINITY;

  // Keyed `region@hour`. NEA republishes revised hours, and the response is not
  // ordered by revision, so we keep the newest `updatedTimestamp` per key
  // rather than trusting array position.
  const best = new Map<string, { reading: SgReading; updatedMs: number }>();

  for (const item of items) {
    if (!isRecord(item)) {
      skipped.badTimestamp += 1;
      continue;
    }

    const observed = parseZoned(item.timestamp);
    if (!observed) {
      skipped.badTimestamp += 1;
      continue;
    }

    const hour = floorToHourUtc(observed);
    if (hour.getTime() > maxTimeMs) {
      skipped.future += 1;
      continue;
    }

    const updated = parseZoned(item.updatedTimestamp);
    // Fall back to the observation time so an item without a revision marker
    // still competes deterministically instead of being ranked at -Infinity.
    const updatedMs = updated?.getTime() ?? observed.getTime();

    const readings = isRecord(item.readings) ? item.readings : null;
    const oneHourly = readings && isRecord(readings.pm25_one_hourly) ? readings.pm25_one_hourly : null;
    if (!oneHourly) {
      skipped.badValue += 1;
      continue;
    }

    for (const [regionRaw, valueRaw] of Object.entries(oneHourly)) {
      const region = regionRaw.toLowerCase();
      if (!REGION_SET.has(region)) continue;

      // Negative values are NEA's missing-data sentinel, and the schema's
      // `pm25_ugm3 >= 0` check would reject them at the database anyway — far
      // better to drop them here with a count than to fail the whole batch.
      if (typeof valueRaw !== 'number' || !Number.isFinite(valueRaw) || valueRaw < 0) {
        skipped.badValue += 1;
        continue;
      }

      const observedAt = hour.toISOString();
      const key = `${region}@${observedAt}`;
      const existing = best.get(key);
      if (existing) {
        skipped.superseded += 1;
        if (existing.updatedMs >= updatedMs) continue;
      }

      best.set(key, {
        updatedMs,
        reading: {
          region: region as SgRegionName,
          observedAt,
          pm25: valueRaw,
          updatedAt: updated?.toISOString() ?? null,
        },
      });
    }
  }

  const readings = [...best.values()]
    .map((v) => v.reading)
    .sort((a, b) => (a.observedAt === b.observedAt ? a.region.localeCompare(b.region) : a.observedAt.localeCompare(b.observedAt)));

  return { ok: true, readings, skipped };
}
