/**
 * airgradient.ts — the AirGradient public-map connector: fetch shape, parser,
 * and the humidity correction that makes the readings usable.
 *
 * Where the data comes from
 * -------------------------
 * `GET https://api.airgradient.com/public/api/v1/world/locations/measures/current`
 * — the keyless JSON feed behind AirGradient's public world map. One call
 * returns every public monitor worldwide (~2,700 rows); we filter to the seeded
 * `source_station_id`s. This is where the Nafas network actually publishes
 * (`publicContributorName: "Nafas"`), after the plan's original route — Nafas
 * via WAQI — turned out not to exist.
 *
 * Licence: CC-BY-SA 4.0 for data via the AirGradient API
 * (airgradient.com/documentation/data-ownership-and-sharing/). Attribution is
 * on /about. The endpoint feeds their map rather than being a formally
 * versioned API, so the parser treats every field as optional and a shape
 * change degrades to "no readings", never to a crash.
 *
 * THE MEASUREMENT CAVEAT — why `correctAirGradientPm25` exists
 * ------------------------------------------------------------
 * These are Plantower-class optical sensors and the API serves RAW `pm02`.
 * Optical counters overread in humid air because hygroscopic particles swell
 * with absorbed water and scatter more light; in the tropics this is not a
 * rounding error — the AirGradient unit at BMKG headquarters read ~52 µg/m³
 * while the co-located reference BAM (WAQI uid 8294) showed ~29.
 *
 * AirGradient's own recommendation for outdoor monitors is the US-EPA
 * correction (Barkjohn et al. 2021, developed on PurpleAir's identical sensor
 * class), applied server-side to raw data. We do exactly that, with their
 * published piecewise form (airgradient.com/documentation/correction-algorithms/):
 *
 *   raw < 30:          0.524·raw − 0.0862·RH + 5.75
 *   30 ≤ raw < 50:     slope blends 0.524 → 0.786 as w = raw/20 − 1.5 goes 0→1
 *   50 ≤ raw < 210:    0.786·raw − 0.0862·RH + 5.75
 *   210 ≤ raw < 260:   linear blend of the mid formula into the high one,
 *                      w = raw/50 − 4.2 going 0→1 (RH term fades out with 1−w)
 *   raw ≥ 260:         2.966 + 0.69·raw + 8.84e-4·raw²   (RH plays no part)
 *
 * Negative outputs clamp to 0. The blends make the curve continuous at every
 * boundary — the tests check that, because a discontinuity would put a
 * permanent phantom step into every daily average that crosses it.
 *
 * The correction narrows the gap; it does not close it. `pm25_ugm3` gets the
 * corrected value, and `raw` retains {pm02, rhum, formula id} — the inputs a
 * re-derivation would need if the formula is ever revised. Note that no such
 * re-derivation script exists yet: the inputs are preserved so one *can* be
 * written, not because one is waiting. Until it is, a formula change leaves
 * stored history on the old basis. `npm run verify:colocation` measures the
 * residual against the Kemayoran BAM on demand.
 *
 * A reading without RH is dropped rather than half-corrected: applying the
 * slope without the RH term biases high by construction, and a silently
 * uncorrected reading is exactly the kind of quiet poison this codebase keeps
 * refusing to store.
 */

import type { Json } from '../../src/lib/types';

export const AIRGRADIENT_WORLD_URL =
  'https://api.airgradient.com/public/api/v1/world/locations/measures/current';

/** Identifier stored in `raw.correction` — bump if the formula ever changes. */
export const CORRECTION_ID = 'epa-barkjohn-2021';

/* -------------------------------------------------------------------------- */
/* Correction                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Is this relative humidity a real measurement, or a dead sensor?
 *
 * Outdoor RH is never exactly 0 anywhere on Earth, and `0` is the value a
 * failed humidity channel reports — three stations in the live world payload
 * were sitting at `rhum: 0` when this was written. Anything at or below 0, or
 * above 100, is therefore a sentinel rather than weather.
 *
 * This matters more than it looks. The correction subtracts 0.0862·RH, so a
 * sentinel that got clamped to 0 instead of rejected would silently inflate
 * the result by ~6.5 µg/m³ at Jakarta's typical 75% RH — a confidently wrong
 * number, which is precisely what this module refuses to store.
 */
export function isPlausibleRh(rh: number): boolean {
  return Number.isFinite(rh) && rh > 0 && rh <= 100;
}

/**
 * Upper bound on a believable raw optical reading, µg/m³.
 *
 * Generous on purpose: Indonesian peat-fire haze genuinely drives these
 * sensors into the high hundreds, and the high-range polynomial is defined for
 * arbitrarily large inputs. The bound exists only to catch a garbage payload,
 * so it sits far above any real air rather than at the edge of plausible air —
 * clipping a real extreme would blind the app exactly when it matters most.
 */
const MAX_PLAUSIBLE_RAW_PM25 = 10_000;

/**
 * US-EPA (Barkjohn 2021) humidity correction, AirGradient's published piecewise
 * form. Returns µg/m³ rounded to one decimal, clamped at 0; `null` when the
 * inputs cannot support a correction (missing/absurd raw or RH).
 *
 * RH is validated, never clamped — see `isPlausibleRh`.
 */
export function correctAirGradientPm25(raw: number, rh: number): number | null {
  if (!Number.isFinite(raw) || raw < 0 || raw > MAX_PLAUSIBLE_RAW_PM25) return null;
  if (!isPlausibleRh(rh)) return null;

  const low = 0.524 * raw - 0.0862 * rh + 5.75;
  const mid = 0.786 * raw - 0.0862 * rh + 5.75;
  const high = 2.966 + 0.69 * raw + 8.84e-4 * raw * raw;

  let corrected: number;
  if (raw < 30) {
    corrected = low;
  } else if (raw < 50) {
    const w = raw / 20 - 1.5; // 0 at raw=30 → 1 at raw=50
    corrected = (0.786 * w + 0.524 * (1 - w)) * raw - 0.0862 * rh + 5.75;
  } else if (raw < 210) {
    corrected = mid;
  } else if (raw < 260) {
    const w = raw / 50 - 4.2; // 0 at raw=210 → 1 at raw=260
    corrected = mid * (1 - w) + high * w;
  } else {
    corrected = high;
  }

  return Math.round(Math.max(0, corrected) * 10) / 10;
}

/* -------------------------------------------------------------------------- */
/* Parsing                                                                    */
/* -------------------------------------------------------------------------- */

export interface AirGradientReading {
  /** The map's numeric locationId, as a string — matches `source_station_id`. */
  locationId: string;
  /** Corrected concentration — what goes into `pm25_ugm3`. */
  pm25Corrected: number;
  /** UTC hour bucket the reading is filed under (measurement time, floored). */
  observedAt: string;
  /** Provenance for the `raw` jsonb column. */
  raw: Json;
}

export interface AirGradientParsed {
  ok: true;
  readings: AirGradientReading[];
  /** Seeded ids that were present but unusable, with the reason — for run meta. */
  skipped: { locationId: string; reason: 'offline' | 'stale' | 'no-pm25' | 'no-rh' | 'bad-timestamp'; detail: string }[];
  /** Seeded ids absent from the payload entirely. */
  missing: string[];
}

export interface AirGradientRejected {
  ok: false;
  reason: 'malformed' | 'empty';
  detail: string;
}

export type AirGradientParseResult = AirGradientParsed | AirGradientRejected;

export interface AirGradientParseOptions {
  /** Clock for staleness — injected so tests need no fake timers. */
  now: Date;
  /** Readings older than this are recorded as stale, not written. */
  staleHours: number;
  /** The seeded `source_station_id`s to extract; everything else is ignored. */
  wanted: ReadonlySet<string>;
}

interface WorldRow {
  locationId?: unknown;
  pm02?: unknown;
  rhum?: unknown;
  atmp?: unknown;
  timestamp?: unknown;
  offline?: unknown;
  publicContributorName?: unknown;
}

/**
 * Extract the wanted stations from a world-map payload.
 *
 * The payload is ~2,700 rows of third-party JSON, so nothing about any row is
 * trusted: a malformed row among the wanted ids becomes a skip with a reason,
 * and a malformed payload overall becomes a rejection — never a throw.
 */
export function parseAirGradientWorld(payload: unknown, options: AirGradientParseOptions): AirGradientParseResult {
  if (!Array.isArray(payload)) {
    return { ok: false, reason: 'malformed', detail: `expected a JSON array, got ${typeof payload}` };
  }
  if (payload.length === 0) {
    return { ok: false, reason: 'empty', detail: 'world payload contained zero locations' };
  }

  const readings: AirGradientReading[] = [];
  const skipped: AirGradientParsed['skipped'] = [];
  const found = new Set<string>();

  for (const item of payload as WorldRow[]) {
    const id = typeof item?.locationId === 'number' || typeof item?.locationId === 'string' ? String(item.locationId) : null;
    if (!id || !options.wanted.has(id)) continue;
    found.add(id);

    // Truthy rather than `=== true`: every other field in this parser is read
    // through a typeof guard precisely because this endpoint feeds a map rather
    // than being a versioned API. If the flag is ever serialised as "true" or 1,
    // a strict check would mark dead stations live and store their last stale
    // reading as current — the one outcome the staleness budget exists to stop.
    if (item.offline === true || item.offline === 'true' || item.offline === 1) {
      skipped.push({ locationId: id, reason: 'offline', detail: `flagged offline by the map (${String(item.offline)})` });
      continue;
    }

    const rawPm = typeof item.pm02 === 'number' ? item.pm02 : null;
    if (rawPm === null) {
      skipped.push({ locationId: id, reason: 'no-pm25', detail: 'no pm02 in payload' });
      continue;
    }

    // Absent *and* implausible RH take the same path: both mean "no usable
    // humidity", and a dead sensor reporting 0 is indistinguishable from a
    // missing field for our purposes. Dropping beats half-correcting, which
    // would bias high by construction — see the file header.
    const rh = typeof item.rhum === 'number' && isPlausibleRh(item.rhum) ? item.rhum : null;
    if (rh === null) {
      const seen = typeof item.rhum === 'number' ? `rhum=${item.rhum}` : 'no rhum';
      skipped.push({ locationId: id, reason: 'no-rh', detail: `pm02=${rawPm} but ${seen}; cannot correct` });
      continue;
    }

    const measuredAt = typeof item.timestamp === 'string' ? new Date(item.timestamp) : null;
    if (!measuredAt || Number.isNaN(measuredAt.getTime())) {
      skipped.push({ locationId: id, reason: 'bad-timestamp', detail: String(item.timestamp) });
      continue;
    }

    const ageHours = (options.now.getTime() - measuredAt.getTime()) / 3_600_000;
    if (ageHours > options.staleHours) {
      skipped.push({ locationId: id, reason: 'stale', detail: `${ageHours.toFixed(1)}h old` });
      continue;
    }

    const corrected = correctAirGradientPm25(rawPm, rh);
    if (corrected === null) {
      skipped.push({ locationId: id, reason: 'no-pm25', detail: `uncorrectable pm02=${rawPm} rhum=${rh}` });
      continue;
    }

    readings.push({
      locationId: id,
      pm25Corrected: corrected,
      // The TRUE measurement instant, not floored to the hour.
      //
      // This reading is an instantaneous sample, not an hourly average, and
      // flooring it would assert the opposite — filing one moment under a whole
      // clock hour as though it described all sixty minutes. Keeping the
      // instant lets several samples per hour coexist under the
      // `(station_id, observed_at)` key, and `aggregateDailyAq` averages them
      // within the station-hour into a real hourly mean.
      //
      // Idempotency survives: the sensor's own timestamp is the key, so
      // re-fetching the same reading rewrites the same row rather than stacking
      // a duplicate.
      observedAt: measuredAt.toISOString(),
      raw: {
        source: 'airgradient',
        location_id: id,
        pm02_raw: rawPm,
        rhum: rh,
        atmp: typeof item.atmp === 'number' ? item.atmp : null,
        measured_at: measuredAt.toISOString(),
        correction: CORRECTION_ID,
        contributor: typeof item.publicContributorName === 'string' ? item.publicContributorName : null,
      } as Json,
    });
  }

  return {
    ok: true,
    readings,
    skipped,
    missing: [...options.wanted].filter((id) => !found.has(id)),
  };
}
