/**
 * time.ts — UTC hour arithmetic shared by every connector.
 *
 * `floorToHourUtc` lived in `waqi.ts` and was imported from there by the
 * data.gov.sg and AirGradient parsers, which coupled two connectors to a third
 * for a function that has nothing to do with any of them. It is calendar
 * arithmetic; it belongs somewhere neutral.
 *
 * (Locale-aware date handling — local dates, timezone bucketing, circular means
 * — lives in `src/lib/format.ts` and is shared with the frontend. This module is
 * only for the UTC-instant helpers the ingestion scripts need.)
 */

/**
 * Truncate an instant to the top of its UTC hour.
 *
 * Used by sources that publish an hourly *average* (WAQI, data.gov.sg): the
 * value describes a whole clock hour, so filing it under that hour is labelling
 * rather than rounding, and it keeps re-runs idempotent against the
 * `(station_id, observed_at)` key if a source ever starts publishing at :30.
 *
 * Deliberately NOT used for sources that publish an instantaneous sample
 * (AirGradient): flooring an instant asserts it represents the hour, which is
 * exactly the claim that is false. Those keep their true measurement time, and
 * `aggregateDailyAq` averages whatever samples an hour actually contains.
 */
export function floorToHourUtc(d: Date): Date {
  const out = new Date(d.getTime());
  out.setUTCMinutes(0, 0, 0);
  return out;
}
