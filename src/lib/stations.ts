/**
 * stations.ts — the location and station registry.
 *
 * A compile-time mirror of `supabase/migrations/0004_seed.sql`. The database is
 * the runtime source of truth; this file exists so scripts and the UI can reason
 * about locations (coordinates for the weather pull, timezone for bucketing,
 * display order) without a round-trip, and so a typo in a slug is a type error
 * rather than an empty result set.
 *
 * **Keep in sync with 0004_seed.sql.** `tests/stations.test.ts` checks the two
 * agree on slugs and timezones.
 */

import type { AqSource, CountryCode, LocationSlug, StationNetwork, TimeZone } from './types';

export interface LocationConfig {
  slug: LocationSlug;
  name: string;
  /** Shorter label for tight UI (cards, chart legends). */
  shortName: string;
  country: CountryCode;
  timezone: TimeZone;
  /** Weather pull point; for Singapore, the region centroid data.gov.sg publishes. */
  lat: number;
  lon: number;
  /** Default card order on the home page. */
  order: number;
  /**
   * Whether a wind-regression fit is expected at launch. Only Jakarta has the
   * 2022–2023 Nafas × BMKG history to fit on; the rest start on CAMS +
   * persistence and are labelled "calibrating" until they accumulate ~90 days.
   */
  calibratedAtLaunch: boolean;
}

/** Every location, in display order. */
export const LOCATIONS: readonly LocationConfig[] = [
  {
    slug: 'jakarta-central',
    name: 'Jakarta (Central)',
    shortName: 'Jakarta',
    country: 'ID',
    timezone: 'Asia/Jakarta',
    lat: -6.1862,
    lon: 106.834,
    order: 1,
    calibratedAtLaunch: true,
  },
  {
    slug: 'bsd',
    name: 'BSD City',
    shortName: 'BSD',
    country: 'ID',
    timezone: 'Asia/Jakarta',
    lat: -6.3019,
    lon: 106.6528,
    order: 2,
    calibratedAtLaunch: true,
  },
  {
    slug: 'bali-denpasar',
    name: 'Denpasar, Bali',
    shortName: 'Bali',
    country: 'ID',
    // WITA, UTC+8 — one hour ahead of Jakarta. A frequent source of off-by-one-day bugs.
    timezone: 'Asia/Makassar',
    lat: -8.65,
    lon: 115.2167,
    order: 3,
    calibratedAtLaunch: false,
  },
  {
    slug: 'sg-central',
    name: 'Singapore Central',
    shortName: 'SG Central',
    country: 'SG',
    timezone: 'Asia/Singapore',
    lat: 1.35735,
    lon: 103.82,
    order: 4,
    calibratedAtLaunch: false,
  },
  {
    slug: 'sg-north',
    name: 'Singapore North',
    shortName: 'SG North',
    country: 'SG',
    timezone: 'Asia/Singapore',
    lat: 1.41803,
    lon: 103.82,
    order: 5,
    calibratedAtLaunch: false,
  },
  {
    slug: 'sg-south',
    name: 'Singapore South',
    shortName: 'SG South',
    country: 'SG',
    timezone: 'Asia/Singapore',
    lat: 1.29587,
    lon: 103.82,
    order: 6,
    calibratedAtLaunch: false,
  },
  {
    slug: 'sg-east',
    name: 'Singapore East',
    shortName: 'SG East',
    country: 'SG',
    timezone: 'Asia/Singapore',
    lat: 1.35735,
    lon: 103.94,
    order: 7,
    calibratedAtLaunch: false,
  },
  {
    slug: 'sg-west',
    name: 'Singapore West',
    shortName: 'SG West',
    country: 'SG',
    timezone: 'Asia/Singapore',
    lat: 1.35735,
    lon: 103.7,
    order: 8,
    calibratedAtLaunch: false,
  },
] as const;

const LOCATION_BY_SLUG: Readonly<Record<LocationSlug, LocationConfig>> = Object.freeze(
  Object.fromEntries(LOCATIONS.map((l) => [l.slug, l])) as Record<LocationSlug, LocationConfig>,
);

export function locationBySlug(slug: string): LocationConfig | null {
  return (LOCATION_BY_SLUG as Record<string, LocationConfig | undefined>)[slug] ?? null;
}

/** Locations served by a given feed source. */
export function locationsForSource(source: AqSource): LocationConfig[] {
  return LOCATIONS.filter((l) => (source === 'datagovsg' ? l.country === 'SG' : l.country === 'ID'));
}

/** A seeded station, mirroring `stations` rows in 0004_seed.sql. */
export interface StationConfig {
  locationSlug: LocationSlug;
  source: AqSource;
  /** WAQI numeric uid without the `@`, or the data.gov.sg region name. */
  sourceStationId: string;
  name: string;
  network: StationNetwork | null;
}

/**
 * WAQI feeds verified live during planning (2026-08-16).
 *
 * Bali runs on a single feed, which is the weakest link in the station map:
 * if Padangsambian Kaja goes dormant, Bali loses its ground truth entirely and
 * falls back to CAMS. `scripts/discover-stations.ts` is meant to resolve the
 * Lumintang and Umalas uids to remove that single point of failure.
 */
export const WAQI_STATIONS: readonly StationConfig[] = [
  {
    locationSlug: 'jakarta-central',
    source: 'waqi',
    sourceStationId: '556480',
    name: 'Menteng 2, Central Jakarta',
    network: 'nafas',
  },
  {
    locationSlug: 'bsd',
    source: 'waqi',
    sourceStationId: '537739',
    name: 'Pondok Aren, South Tangerang',
    network: 'nafas',
  },
  {
    locationSlug: 'bali-denpasar',
    source: 'waqi',
    sourceStationId: '503785',
    name: 'Padangsambian Kaja, Denpasar',
    network: null,
  },
] as const;

/** Singapore reports PM2.5 per region, so the "station" is the region itself. */
export const DATAGOVSG_STATIONS: readonly StationConfig[] = [
  { locationSlug: 'sg-central', source: 'datagovsg', sourceStationId: 'central', name: 'NEA Central region', network: 'nea' },
  { locationSlug: 'sg-north', source: 'datagovsg', sourceStationId: 'north', name: 'NEA North region', network: 'nea' },
  { locationSlug: 'sg-south', source: 'datagovsg', sourceStationId: 'south', name: 'NEA South region', network: 'nea' },
  { locationSlug: 'sg-east', source: 'datagovsg', sourceStationId: 'east', name: 'NEA East region', network: 'nea' },
  { locationSlug: 'sg-west', source: 'datagovsg', sourceStationId: 'west', name: 'NEA West region', network: 'nea' },
] as const;

export const ALL_STATIONS: readonly StationConfig[] = [...WAQI_STATIONS, ...DATAGOVSG_STATIONS] as const;

/* -------------------------------------------------------------------------- */
/* Ingestion tuning                                                           */
/* -------------------------------------------------------------------------- */

/**
 * A WAQI feed older than this is treated as no reading at all.
 *
 * Nafas feeds do go quiet, and a stale value is worse than a missing one: it
 * would be bucketed into today's average as though it were current, dragging the
 * rollup toward hours-old air.
 */
export const STALE_FEED_HOURS = 6;

/** Consecutive days unseen before a station is flagged `is_active = false`. */
export const DORMANT_STATION_DAYS = 14;

/**
 * Minimum distinct local hours before a day's average is allowed to score a
 * prediction. Below this the "actual" is too thin to judge a model by.
 */
export const MIN_HOURS_FOR_SCORING = 12;

/** Scored days needed before MAE is trusted to pick the headline model. */
export const MIN_SCORED_DAYS_FOR_RANKING = 7;
