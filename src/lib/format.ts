/**
 * format.ts — timezone-aware date handling.
 *
 * This file is small and load-bearing. Every daily rollup, every prediction
 * target date and every chart axis is bucketed by a location's **local**
 * calendar date, and the three zones we cover are all ahead of UTC:
 *
 *   Asia/Jakarta   WIB   UTC+7
 *   Asia/Makassar  WITA  UTC+8   (Bali — not Asia/Jakarta)
 *   Asia/Singapore SGT   UTC+8
 *
 * So 2026-08-16T17:00Z is already 2026-08-17 in Jakarta. Bucketing on the UTC
 * date would push the last 7 hours of every Jakarta day into the next day's
 * average — a silent ~30% corruption of the exact quantity the model is fit on.
 *
 * None of these zones observes DST, so a fixed offset would work today. The
 * offsets are still derived from the IANA database via `Intl` rather than
 * hard-coded, because a hard-coded offset is a landmine for anyone who later
 * adds a location that does observe DST.
 */

import type { IsoTimestamp, LocalDate, TimeZone } from './types';

/** Milliseconds in a day. */
const DAY_MS = 86_400_000;

/**
 * Offset of `tz` from UTC, in milliseconds, at the instant `date`.
 * Positive east of Greenwich (so +7h for Jakarta).
 *
 * Works by asking `Intl` what the wall-clock reads in that zone, reinterpreting
 * those fields as if they were UTC, and differencing. This is the standard
 * approach and is DST-correct by construction.
 */
function zoneOffsetMs(date: Date, tz: TimeZone): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const parts: Record<string, number> = {};
  for (const p of dtf.formatToParts(date)) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }

  const asIfUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    // `h23` yields 00..23, but guard anyway: some ICU builds emit 24 for midnight.
    parts.hour % 24,
    parts.minute,
    parts.second,
  );

  return asIfUtc - date.getTime();
}

/** Coerce the accepted input shapes to a Date, or null if unparseable. */
function toDate(instant: IsoTimestamp | Date | number): Date | null {
  const d = instant instanceof Date ? instant : new Date(instant);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Zero-padded `YYYY-MM-DD` from UTC fields of a Date. */
function utcFieldsToIsoDate(d: Date): LocalDate {
  const y = String(d.getUTCFullYear()).padStart(4, '0');
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * The calendar date in `tz` at the given instant — the rollup bucket key.
 *
 * @example toLocalDate('2026-08-16T17:00:00Z', 'Asia/Jakarta') === '2026-08-17'
 */
export function toLocalDate(instant: IsoTimestamp | Date | number, tz: TimeZone): LocalDate | null {
  const d = toDate(instant);
  if (!d) return null;
  return utcFieldsToIsoDate(new Date(d.getTime() + zoneOffsetMs(d, tz)));
}

/** The local hour-of-day (0–23) at the given instant. */
export function toLocalHour(instant: IsoTimestamp | Date | number, tz: TimeZone): number | null {
  const d = toDate(instant);
  if (!d) return null;
  return new Date(d.getTime() + zoneOffsetMs(d, tz)).getUTCHours();
}

/**
 * Short local hour label for chart axes, e.g. `16:00`.
 * Formatted server-side so the client's own timezone can never shift a label.
 */
export function toLocalHourLabel(instant: IsoTimestamp | Date | number, tz: TimeZone): string | null {
  const h = toLocalHour(instant, tz);
  return h === null ? null : `${String(h).padStart(2, '0')}:00`;
}

/** Validate and split a `YYYY-MM-DD`. */
function parseLocalDate(localDate: LocalDate): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  // Reject impossible dates like 2026-02-30, which Date.UTC would roll over.
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
  return { y, m, d };
}

/**
 * The UTC instant of local midnight starting `localDate` in `tz`.
 *
 * Two-pass: guess by treating the local wall time as UTC, then correct using the
 * offset in force at that guess. The second pass matters only for zones with DST
 * transitions — kept so this stays correct if such a location is ever added.
 */
export function localDateStartUtc(localDate: LocalDate, tz: TimeZone): Date | null {
  const parts = parseLocalDate(localDate);
  if (!parts) return null;
  const wallAsUtc = Date.UTC(parts.y, parts.m - 1, parts.d, 0, 0, 0);
  const firstGuess = wallAsUtc - zoneOffsetMs(new Date(wallAsUtc), tz);
  return new Date(wallAsUtc - zoneOffsetMs(new Date(firstGuess), tz));
}

/**
 * Half-open UTC window `[start, end)` covering one local day.
 *
 * This is the range to hand Postgres when selecting the hourly rows that make up
 * a daily rollup. Half-open avoids double-counting the boundary hour.
 */
export function localDayUtcRange(
  localDate: LocalDate,
  tz: TimeZone,
): { start: Date; end: Date; startIso: IsoTimestamp; endIso: IsoTimestamp } | null {
  const start = localDateStartUtc(localDate, tz);
  if (!start) return null;
  const next = addLocalDays(localDate, 1);
  const end = next ? localDateStartUtc(next, tz) : null;
  if (!end) return null;
  return { start, end, startIso: start.toISOString(), endIso: end.toISOString() };
}

/**
 * Shift a local date by whole days. Calendar arithmetic on the date fields, so
 * it is unaffected by any offset change in between.
 */
export function addLocalDays(localDate: LocalDate, days: number): LocalDate | null {
  const parts = parseLocalDate(localDate);
  if (!parts || !Number.isInteger(days)) return null;
  return utcFieldsToIsoDate(new Date(Date.UTC(parts.y, parts.m - 1, parts.d) + days * DAY_MS));
}

/** Whole days from `a` to `b` (`b - a`); negative when `b` precedes `a`. */
export function diffLocalDays(a: LocalDate, b: LocalDate): number | null {
  const pa = parseLocalDate(a);
  const pb = parseLocalDate(b);
  if (!pa || !pb) return null;
  const ta = Date.UTC(pa.y, pa.m - 1, pa.d);
  const tb = Date.UTC(pb.y, pb.m - 1, pb.d);
  return Math.round((tb - ta) / DAY_MS);
}

/** Today's local date in `tz`. `now` is injectable so tests need no clock control. */
export function todayLocalDate(tz: TimeZone, now: Date = new Date()): LocalDate | null {
  return toLocalDate(now, tz);
}

/** Tomorrow's local date in `tz` — the app's default prediction target. */
export function tomorrowLocalDate(tz: TimeZone, now: Date = new Date()): LocalDate | null {
  const today = todayLocalDate(tz, now);
  return today ? addLocalDays(today, 1) : null;
}

/** Inclusive list of local dates from `start` to `end`. Empty if reversed. */
export function localDateRange(start: LocalDate, end: LocalDate): LocalDate[] {
  const span = diffLocalDays(start, end);
  if (span === null || span < 0) return [];
  const out: LocalDate[] = [];
  for (let i = 0; i <= span; i += 1) {
    const d = addLocalDays(start, i);
    if (d) out.push(d);
  }
  return out;
}

/**
 * Circular (vector) mean of wind directions in degrees, with the resultant
 * length as a consistency measure.
 *
 * A scalar mean is wrong here and wrong in a way that hides the seasonal signal
 * the analysis depends on: averaging 350° and 10° arithmetically gives 180°
 * (due south) when the answer is 0° (due north). Since the dry-season easterly
 * versus wet-season north-westerly contrast is precisely what distinguishes
 * Jakarta's clean days from its dirty ones, that error would erase the effect.
 *
 * `consistency` is 0..1: near 1 the wind held one direction all day; near 0 it
 * boxed the compass and the mean direction carries no information.
 */
export function circularMeanDegrees(
  degrees: readonly (number | null | undefined)[],
): { mean: number; consistency: number } | null {
  let sumSin = 0;
  let sumCos = 0;
  let n = 0;
  for (const deg of degrees) {
    if (deg === null || deg === undefined || !Number.isFinite(deg)) continue;
    const rad = (deg * Math.PI) / 180;
    sumSin += Math.sin(rad);
    sumCos += Math.cos(rad);
    n += 1;
  }
  if (n === 0) return null;

  const meanSin = sumSin / n;
  const meanCos = sumCos / n;
  const consistency = Math.min(1, Math.sqrt(meanSin * meanSin + meanCos * meanCos));

  // atan2 yields (-180, 180]. Normalising with a single `+= 360` is not enough:
  // a mean of -1e-15 (which is what averaging 350° and 10° actually produces in
  // floating point) would become 360, i.e. outside the [0, 360) range callers
  // expect. The double modulo folds that back to 0.
  const raw = (Math.atan2(meanSin, meanCos) * 180) / Math.PI;
  const mean = ((raw % 360) + 360) % 360;

  return { mean, consistency };
}

/** 16-point compass label for a direction in degrees. */
export function compassPoint(degrees: number): string | null {
  if (!Number.isFinite(degrees)) return null;
  const points = [
    'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
    'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW',
  ];
  const idx = Math.round((((degrees % 360) + 360) % 360) / 22.5) % 16;
  return points[idx];
}
