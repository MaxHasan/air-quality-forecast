/**
 * waqi.ts — parsing a WAQI station feed into one hourly observation.
 *
 * Pure: no I/O, no clock (the clock is injected). Everything that could go
 * wrong with a third-party payload is enumerated as a `reason`, because the
 * ingestion script needs to distinguish "this station is dead, deactivate it"
 * from "this hour has no PM2.5" from "we asked the wrong question".
 *
 * ---------------------------------------------------------------------------
 * Four things about WAQI that are only learnable by calling it
 * ---------------------------------------------------------------------------
 *
 * 1. **A bad station id is an HTTP 200.** The envelope reads
 *    `{"status":"ok","data":{"status":"error","msg":"Unknown ID"}}` — success at
 *    the transport layer, failure one level down, and `data` shaped like an
 *    object rather than the documented error *string*. Nothing in the status
 *    code or the outer `status` gives it away, so it is detected structurally.
 *
 * 2. **`iaqi.pm25.v` is an AQI sub-index, not µg/m³.** Storing it as a
 *    concentration would roughly double every Indonesian reading. It is
 *    inverted through src/lib/aqi.ts, and both numbers plus the breakpoint
 *    table used are persisted so a wrong table stays correctable in place.
 *
 * 3. **Only `time.iso` is trustworthy.** `time.s` is a naive local string,
 *    which `new Date()` would interpret in the *runner's* timezone — correct on
 *    a UTC CI runner, wrong by seven hours on the author's laptop, and the kind
 *    of bug that only shows up as a slightly-wrong daily average. `time.v`
 *    (unix seconds) is worse: for @8294 it is offset by the station's own
 *    timezone, so it disagrees with `time.iso` by seven hours. Observed live on
 *    2026-08-16. We therefore require an explicit offset or `Z` on `time.iso`
 *    and reject anything else rather than guessing.
 *
 * 4. **The rendered offset is not stable.** The same instant arrives as
 *    `2026-08-16T20:00:00+07:00` from `/feed/` and `2026-08-16T22:00:00+09:00`
 *    from `/v2/map/bounds/`. Both parse to the same UTC instant, which is why
 *    the instant — never the wall-clock fields — is what gets stored.
 */

import { aqiToPm25, DEFAULT_AQI_TABLE_ID, DEFAULT_PM25_BREAKPOINTS, type AqiBreakpointTable } from '../../src/lib/aqi';
import type { AqiTableId, IsoTimestamp, Json } from '../../src/lib/types';

/** Why a feed produced no observation. */
export type WaqiRejectReason =
  /** Body was not a WAQI envelope at all. */
  | 'malformed'
  /** `{"status":"error"}` at the envelope level. */
  | 'api-error'
  /** The HTTP-200 "Unknown ID" shape — the station no longer exists. */
  | 'unknown-id'
  /** No usable `time.iso` (missing, unparseable, or offset-less). */
  | 'no-timestamp'
  /** Timestamp is implausibly far in the future — almost always a timezone bug. */
  | 'implausible-time'
  /** No `iaqi.pm25.v`. The station reports other pollutants but not this one. */
  | 'no-pm25'
  /** AQI outside 0–500, so the inversion has no defined answer. */
  | 'out-of-range'
  /** Older than the staleness budget: a real reading, but not for now. */
  | 'stale';

export interface WaqiObservation {
  ok: true;
  /** UTC instant, floored to the hour. */
  observedAt: IsoTimestamp;
  /** The published sub-index, stored verbatim in `pm25_aqi_us`. */
  aqi: number;
  /** Inverted concentration, µg/m³. */
  pm25: number;
  /** Which breakpoint table did the inversion. */
  aqiTable: AqiTableId;
  /** Hours between `observedAt` and `now`. Negative means the future. */
  ageHours: number;
  /** `data.city.name`, for logs and station discovery. */
  stationName: string | null;
  /** Attribution names — the licence obligation, surfaced by discover-stations. */
  attributions: string[];
  /** The payload to persist in `aq_observations.raw`. */
  raw: Json;
}

export interface WaqiRejection {
  ok: false;
  reason: WaqiRejectReason;
  detail: string;
  /** Present for `stale`: the run still learns the station is alive. */
  observedAt?: IsoTimestamp;
  ageHours?: number;
}

export type WaqiParseResult = WaqiObservation | WaqiRejection;

export interface WaqiParseOptions {
  /** Injected clock. */
  now: Date;
  /** Readings older than this are rejected as `stale`. */
  staleHours: number;
  /** Breakpoint table for the inversion. */
  table?: AqiBreakpointTable;
  /**
   * How far into the future a timestamp may sit before it is treated as a
   * parsing accident rather than data. Feeds do occasionally lead the wall
   * clock by a few minutes; seven hours means someone read a naive local time
   * as UTC.
   */
  maxFutureHours?: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * ISO-8601 with an explicit zone: `Z` or `±HH:MM` / `±HHMM`.
 * The whole point is to *reject* offset-less strings — see note 3 above.
 */
const ZONED_ISO = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

/**
 * Floor an instant to the top of its UTC hour.
 *
 * `aq_observations` is keyed on `(station_id, observed_at)` and the daily
 * rollup counts *distinct local hours*, so one row per station-hour is the
 * intended grain. WAQI reports exact hours today; flooring makes that a
 * property of our storage rather than a hope about theirs, and keeps re-runs
 * idempotent if it ever starts publishing at :30.
 */
export function floorToHourUtc(d: Date): Date {
  const out = new Date(d.getTime());
  out.setUTCMinutes(0, 0, 0);
  return out;
}

/**
 * Parse one `/feed/@{uid}/` response.
 *
 * `payload` is deliberately `unknown`: the declared `WaqiFeedResponse` in
 * types.ts describes the documented shape, and this function's job is to cope
 * with the undocumented ones.
 */
export function parseWaqiFeed(payload: unknown, options: WaqiParseOptions): WaqiParseResult {
  const table = options.table ?? DEFAULT_PM25_BREAKPOINTS;
  const maxFutureHours = options.maxFutureHours ?? 3;

  if (!isRecord(payload)) {
    return { ok: false, reason: 'malformed', detail: `expected an object, got ${typeof payload}` };
  }

  const outerStatus = payload.status;
  const data = payload.data;

  // The documented error shape: `{"status":"error","data":"<message>"}`.
  //
  // Only "Unknown ID" maps to `unknown-id`. A bad token answers `"Invalid key"`
  // through the same channel, and treating that as a dead station would tell the
  // operator to go hunting for a replacement sensor when the actual problem is
  // one expired secret — and would do it for every station at once.
  if (outerStatus === 'error') {
    const msg = typeof data === 'string' ? data : JSON.stringify(data ?? null).slice(0, 200);
    return {
      ok: false,
      reason: /unknown id|not found/i.test(msg) ? 'unknown-id' : 'api-error',
      detail: msg,
    };
  }

  if (typeof data === 'string') {
    return { ok: false, reason: 'api-error', detail: data.slice(0, 200) };
  }
  if (!isRecord(data)) {
    return { ok: false, reason: 'malformed', detail: 'response has no `data` object' };
  }

  // The undocumented one, observed live: HTTP 200, outer status "ok", and the
  // failure hidden inside `data`. This is the branch that catches a dead uid.
  if (data.status === 'error') {
    const msg = typeof data.msg === 'string' ? data.msg : 'unspecified error';
    return {
      ok: false,
      reason: /unknown id|not found/i.test(msg) ? 'unknown-id' : 'api-error',
      detail: msg,
    };
  }

  /* ---- timestamp ---------------------------------------------------------- */

  const time = isRecord(data.time) ? data.time : null;
  const iso = typeof time?.iso === 'string' ? time.iso.trim() : null;
  if (!iso) {
    return { ok: false, reason: 'no-timestamp', detail: '`time.iso` absent — `time.s` is naive and unusable' };
  }
  if (!ZONED_ISO.test(iso)) {
    return { ok: false, reason: 'no-timestamp', detail: `\`time.iso\` carries no UTC offset: ${iso}` };
  }
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return { ok: false, reason: 'no-timestamp', detail: `unparseable \`time.iso\`: ${iso}` };
  }

  const observedAtDate = floorToHourUtc(parsed);
  const observedAt = observedAtDate.toISOString();
  const ageHours = (options.now.getTime() - observedAtDate.getTime()) / 3_600_000;

  if (ageHours < -maxFutureHours) {
    return {
      ok: false,
      reason: 'implausible-time',
      detail: `observation is ${(-ageHours).toFixed(1)}h in the future (${iso}) — suspect a timezone misread`,
      observedAt,
      ageHours,
    };
  }

  /* ---- concentration ------------------------------------------------------ */

  const iaqi = isRecord(data.iaqi) ? data.iaqi : null;
  const pm25Entry = iaqi && isRecord(iaqi.pm25) ? iaqi.pm25 : null;
  const rawAqi = pm25Entry?.v;
  if (typeof rawAqi !== 'number' || !Number.isFinite(rawAqi)) {
    const present = iaqi ? Object.keys(iaqi).join(',') : 'none';
    return { ok: false, reason: 'no-pm25', detail: `no numeric iaqi.pm25.v (pollutants present: ${present})` };
  }

  const pm25 = aqiToPm25(rawAqi, table);
  if (pm25 === null) {
    return { ok: false, reason: 'out-of-range', detail: `AQI ${rawAqi} falls outside ${table.id}` };
  }

  // Staleness is checked *after* the value is validated so the caller can still
  // report what the stale reading was, and so a station publishing garbage is
  // distinguishable from one publishing nothing.
  if (ageHours > options.staleHours) {
    return {
      ok: false,
      reason: 'stale',
      detail: `${ageHours.toFixed(1)}h old (budget ${options.staleHours}h), last value AQI ${rawAqi}`,
      observedAt,
      ageHours,
    };
  }

  const city = isRecord(data.city) ? data.city : null;
  const attributions = Array.isArray(data.attributions)
    ? data.attributions
        .map((a) => (isRecord(a) && typeof a.name === 'string' ? a.name : null))
        .filter((n): n is string => n !== null)
    : [];

  return {
    ok: true,
    observedAt,
    aqi: Math.round(rawAqi),
    pm25,
    aqiTable: table.id === DEFAULT_PM25_BREAKPOINTS.id ? DEFAULT_AQI_TABLE_ID : table.id,
    ageHours,
    stationName: typeof city?.name === 'string' ? city.name : null,
    attributions,
    raw: payload as Json,
  };
}

/**
 * Guess the upstream network from WAQI's attribution URLs/names.
 *
 * Used only by `discover-stations.ts` to pre-fill `stations.network` in the
 * generated seed SQL. Returns `null` when unsure — the column is nullable
 * precisely so an unconfirmed network is recorded as unknown rather than
 * guessed wrong.
 */
export function guessNetwork(attributions: readonly { name?: string; url?: string }[]): string | null {
  const haystack = attributions
    .map((a) => `${a.name ?? ''} ${a.url ?? ''}`)
    .join(' ')
    .toLowerCase();
  if (haystack.includes('nafas')) return 'nafas';
  if (haystack.includes('bmkg')) return 'bmkg';
  if (haystack.includes('kemenlh') || haystack.includes('klhk') || haystack.includes('lingkungan hidup')) return 'klhk';
  if (haystack.includes('nea') || haystack.includes('national environment agency')) return 'nea';
  return null;
}
