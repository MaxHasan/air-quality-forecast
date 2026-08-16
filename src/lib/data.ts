/**
 * data.ts — the one seam every page and component reads through.
 *
 * Since M4 these six functions resolve to the live Supabase reads in
 * `queries.ts`. The fixtures in `mock-data.ts` are kept and remain selectable, so
 * the UI can still be built and reviewed with no database, no credentials and no
 * network — set `USE_MOCK_DATA=1`.
 *
 * The switch is a runtime dispatch rather than a conditional re-export because
 * ESM has no conditional `export … from`. Reading the flag inside `source()`
 * instead of once at module load is deliberate: it keeps the choice observable to
 * tests that set the variable after import, and the cost is one map lookup per
 * call against a query that talks to Postgres.
 *
 * Components never import `queries.ts` or `mock-data.ts` directly — that is what
 * makes this file the only place the data source is decided.
 */

import * as mock from './mock-data';
import * as live from './queries';
import type {
  DailyPoint,
  HourlyPoint,
  IngestionHealth,
  LocationForecast,
  LocationSlug,
  ModelAccuracyRow,
} from './types';

/** The six functions every page reads through. Both modules must satisfy it. */
export interface DataSource {
  getLocationForecasts(): Promise<LocationForecast[]>;
  getLocationForecast(slug: LocationSlug): Promise<LocationForecast | null>;
  getHourlyPm25(slug: LocationSlug, hours?: number): Promise<HourlyPoint[]>;
  getDailyHistory(slug: LocationSlug): Promise<DailyPoint[]>;
  getModelAccuracy(): Promise<ModelAccuracyRow[]>;
  getIngestionHealth(): Promise<IngestionHealth>;
}

// Typed as `DataSource` rather than inferred, so a signature drifting on either
// side is a compile error here rather than a runtime surprise on one code path.
const LIVE: DataSource = live;
const MOCK: DataSource = mock;

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

/**
 * True when the fixtures are selected.
 *
 * `NEXT_PUBLIC_USE_MOCK_DATA` is accepted as well so the flag survives into a
 * client bundle if a future component ever needs to know; the default, with
 * neither set, is the real database.
 */
export function isMockDataEnabled(): boolean {
  const raw = process.env.USE_MOCK_DATA ?? process.env.NEXT_PUBLIC_USE_MOCK_DATA;
  return raw !== undefined && TRUTHY.has(raw.trim().toLowerCase());
}

function source(): DataSource {
  return isMockDataEnabled() ? MOCK : LIVE;
}

export function getLocationForecasts(): Promise<LocationForecast[]> {
  return source().getLocationForecasts();
}

export function getLocationForecast(slug: LocationSlug): Promise<LocationForecast | null> {
  return source().getLocationForecast(slug);
}

export function getHourlyPm25(slug: LocationSlug, hours?: number): Promise<HourlyPoint[]> {
  return source().getHourlyPm25(slug, hours);
}

export function getDailyHistory(slug: LocationSlug): Promise<DailyPoint[]> {
  return source().getDailyHistory(slug);
}

export function getModelAccuracy(): Promise<ModelAccuracyRow[]> {
  return source().getModelAccuracy();
}

export function getIngestionHealth(): Promise<IngestionHealth> {
  return source().getIngestionHealth();
}
