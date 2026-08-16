/**
 * data.ts — the one seam every page and component reads through.
 *
 * Right now this re-exports the mock fixtures in `mock-data.ts`. Milestone M4
 * swaps these six functions for real Supabase reads (`getAnonClient()` from
 * `src/lib/db.ts`) with the exact same signatures — components never import
 * `mock-data.ts` directly, so that swap should not touch `src/app/**` or
 * `src/components/**` at all.
 */

export {
  getLocationForecasts,
  getLocationForecast,
  getHourlyPm25,
  getDailyHistory,
  getModelAccuracy,
  getIngestionHealth,
} from './mock-data';
