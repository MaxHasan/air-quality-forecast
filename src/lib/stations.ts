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
   * Whether a wind-regression fit is expected at launch. Every Jabodetabek
   * location has 2022–2023 Nafas history to fit on — one CSV per DKI city
   * plus the satellites — so all six carry seeded coefficients. Bali and the
   * five Singapore regions start on CAMS + persistence and are labelled
   * "calibrating" until they accumulate ~90 days.
   */
  calibratedAtLaunch: boolean;
}

/** Every location, in display order. */
export const LOCATIONS: readonly LocationConfig[] = [
  {
    slug: 'jakarta-central',
    name: 'Jakarta Central',
    shortName: 'Jkt Central',
    country: 'ID',
    // UNCHANGED from the pre-decomposition anchor. This point is baked into the
    // ERA5 pull behind the fitted coefficients; moving it would silently refit
    // the model against a different column of weather.
    lat: -6.1862,
    lon: 106.834,
    timezone: 'Asia/Jakarta',
    order: 1,
    calibratedAtLaunch: true,
  },
  {
    slug: 'jakarta-north',
    name: 'Jakarta North',
    shortName: 'Jkt North',
    country: 'ID',
    timezone: 'Asia/Jakarta',
    // Centroid of Jakarta Utara, the coastal strip. Its one feed (KBN Marunda)
    // sits at the eastern end, ~7 km away.
    lat: -6.1214,
    lon: 106.8827,
    order: 2,
    calibratedAtLaunch: true,
  },
  {
    slug: 'jakarta-south',
    name: 'Jakarta South',
    shortName: 'Jkt South',
    country: 'ID',
    timezone: 'Asia/Jakarta',
    lat: -6.2615,
    lon: 106.8106,
    order: 3,
    calibratedAtLaunch: true,
  },
  {
    slug: 'jakarta-west',
    name: 'Jakarta West',
    shortName: 'Jkt West',
    country: 'ID',
    timezone: 'Asia/Jakarta',
    lat: -6.1683,
    lon: 106.7588,
    order: 4,
    calibratedAtLaunch: true,
  },
  {
    // South Tangerang, the western satellite. Banten province, not DKI.
    slug: 'bsd',
    name: 'BSD City',
    shortName: 'BSD',
    country: 'ID',
    timezone: 'Asia/Jakarta',
    lat: -6.3019,
    lon: 106.6528,
    order: 5,
    calibratedAtLaunch: true,
  },
  {
    // Kota Bekasi, the eastern satellite — BSD's counterpart on the other side
    // of the metropolis, and the closest thing to an east-side reading there is.
    // It is NOT a stand-in for Jakarta Timur, which has no feed at all; it is
    // labelled Bekasi because that is what the sensor measures.
    slug: 'bekasi',
    name: 'Bekasi',
    shortName: 'Bekasi',
    country: 'ID',
    timezone: 'Asia/Jakarta',
    lat: -6.2383,
    lon: 106.9756,
    order: 6,
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
    order: 7,
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
    order: 8,
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
    order: 9,
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
    order: 10,
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
    order: 11,
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
    order: 12,
    calibratedAtLaunch: false,
  },
] as const;

const LOCATION_BY_SLUG: Readonly<Record<LocationSlug, LocationConfig>> = Object.freeze(
  Object.fromEntries(LOCATIONS.map((l) => [l.slug, l])) as Record<LocationSlug, LocationConfig>,
);

export function locationBySlug(slug: string): LocationConfig | null {
  return (LOCATION_BY_SLUG as Record<string, LocationConfig | undefined>)[slug] ?? null;
}

/**
 * Locations served by a given feed source.
 *
 * Derived from the station registry rather than from a country rule. The
 * earlier form was `source === 'datagovsg' ? SG : ID`, which silently sent
 * every non-datagovsg source down the Indonesia branch — correct only by
 * accident once AirGradient arrived, and wrong the moment one of its 15 live
 * Singapore stations is seeded. Reading the answer off ALL_STATIONS means a new
 * source or a re-homed station cannot desynchronise this from reality.
 */
export function locationsForSource(source: AqSource): LocationConfig[] {
  const slugs = new Set(ALL_STATIONS.filter((s) => s.source === source).map((s) => s.locationSlug));
  return LOCATIONS.filter((l) => slugs.has(l.slug));
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
 * WAQI feeds, resolved live against the API on 2026-08-16 via
 * `GET /v2/map/bounds/` over the Jabodetabek and Bali bounding boxes, and each
 * one confirmed to return a fresh `iaqi.pm25.v`.
 *
 * Two corrections to the original plan, both discovered by actually calling the
 * API rather than trusting the station list:
 *
 * 1. **There are no Nafas feeds on WAQI.** The uids the plan named for Menteng,
 *    Pondok Aren and Padangsambian Kaja all return `{"status":"error",
 *    "msg":"Unknown ID"}`. A bounds sweep of Jabodetabek returns 13 stations and
 *    not one is attributed to Nafas. Indonesian ground truth here is BMKG, KLHK
 *    (Kementerian Lingkungan Hidup dan Kehutanan) and a single Clarity sensor.
 *    Nafas remains reachable only through their own app.
 *
 * 2. **Bali has exactly one station in range** — Badung Sempidi, ~6 km
 *    north-west of central Denpasar. There is no redundancy: if it goes dormant,
 *    Bali falls back to CAMS alone. (AirGradient later fixed this; see below.)
 *
 * Re-swept 2026-08-19 for the Jakarta decomposition (0007). The Jabodetabek box
 * still returns 14 stations, and two of the nine that 0004 listed as "found but
 * not seeded" now have a location to attach to: `-531679` KBN Marunda becomes
 * Jakarta North's only feed, and `-416815` Bekasi Kayuringin becomes Bekasi's.
 * The same sweep is what establishes that **Jakarta Timur has no feed at all**
 * — not in WAQI, not on the AirGradient map — which is why there is no
 * `jakarta-east` location. Bekasi is the nearest eastern reading and is named
 * Bekasi, because that is the city it is in.
 *
 * The silver lining is @8294: Kemayoran is the *same* BMKG station whose 2022–23
 * weather the wind model is calibrated on, so Jakarta's ground truth and its
 * training weather come from one place. It is also the only Indonesian feed that
 * carries WAQI's 8-day CAMS-derived forecast block.
 *
 * WAQI's feeds run roughly one hour behind the observation hour — worth knowing
 * when reconciling against another source, though well inside STALE_FEED_HOURS.
 */
export const WAQI_STATIONS: readonly StationConfig[] = [
  {
    locationSlug: 'jakarta-central',
    source: 'waqi',
    sourceStationId: '8294',
    name: 'Kemayoran, Central Jakarta',
    network: 'bmkg',
  },
  {
    // Second Central feed so the location survives one station going quiet.
    // GBK sits in Gelora, Tanah Abang — Jakarta Pusat administratively, though
    // right on the Selatan border. Distance nearly ties (4.7 km from Central's
    // anchor, 5.2 km from South's), so the administrative boundary decides it,
    // and it keeps jakarta-central's station mix identical to what its fitted
    // coefficients were scored against.
    locationSlug: 'jakarta-central',
    source: 'waqi',
    sourceStationId: '-416842',
    name: 'Jakarta GBK',
    network: 'klhk',
  },
  {
    // Jakarta Utara's only feed, in either network. Verified live 2026-08-19:
    // fresh iaqi.pm25, attributed to KLHK. If it goes quiet, Jakarta North has
    // nothing — the same single-point-of-failure Bali used to have.
    locationSlug: 'jakarta-north',
    source: 'waqi',
    sourceStationId: '-531679',
    name: 'KBN Marunda, North Jakarta',
    network: 'klhk',
  },
  {
    locationSlug: 'bsd',
    source: 'waqi',
    sourceStationId: '-416785',
    name: 'Tangerang Selatan, Serpong',
    network: 'klhk',
  },
  {
    // Kota Bekasi's only feed. The eastern satellite's whole ground truth.
    locationSlug: 'bekasi',
    source: 'waqi',
    sourceStationId: '-416815',
    name: 'Bekasi Kayuringin',
    network: 'klhk',
  },
  {
    locationSlug: 'bali-denpasar',
    source: 'waqi',
    sourceStationId: '-519205',
    name: 'Badung Sempidi, Bali',
    network: 'klhk',
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

/**
 * AirGradient public-map stations, resolved live on 2026-08-18 — where the
 * Nafas network actually publishes (`publicContributorName: "Nafas"`), after
 * WAQI turned out to carry no Nafas feeds at all. Data is CC-BY-SA 4.0.
 *
 * `sourceStationId` is the map's numeric `locationId`. Readings arrive as RAW
 * optical-sensor values and are EPA-humidity-corrected by the connector before
 * storage — see scripts/lib/airgradient.ts for the correction and its caveats.
 *
 * 199980 sits at BMKG headquarters beside the Kemayoran reference BAM
 * (waqi 8294): the standing co-location pair for `npm run verify:colocation`.
 * Bali goes from one station (WAQI Sempidi) to four here, which is the end of
 * its single point of failure.
 *
 * Re-verified 2026-08-19 for 0007. All eight rows below still report, and the
 * three stations 0006 found but could not place — it recorded them as "live
 * but seeded nowhere, because no location covers them" — now have one:
 * 84701 Kedoya Utara becomes Jakarta West's only feed, and 175134 Permata Hijau
 * plus 77248 Pakubuwono 3 give Jakarta South a pair. Coordinates below are
 * copied verbatim from the world payload, per 0006's warning about hand-typed
 * ones being 0.9–2.3 km wrong.
 */
export const AIRGRADIENT_STATIONS: readonly StationConfig[] = [
  { locationSlug: 'jakarta-central', source: 'airgradient', sourceStationId: '84702', name: 'The Pakubuwono Menteng', network: null },
  { locationSlug: 'jakarta-central', source: 'airgradient', sourceStationId: '199980', name: 'BMKG 1 (co-located with Kemayoran BAM)', network: null },
  { locationSlug: 'jakarta-west', source: 'airgradient', sourceStationId: '84701', name: 'Kedoya Utara, Kebon Jeruk', network: 'nafas' },
  { locationSlug: 'jakarta-south', source: 'airgradient', sourceStationId: '175134', name: 'Permata Hijau, Kebayoran Lama', network: 'nafas' },
  { locationSlug: 'jakarta-south', source: 'airgradient', sourceStationId: '77248', name: 'Pakubuwono 3, Kebayoran Baru', network: 'nafas' },
  { locationSlug: 'bsd', source: 'airgradient', sourceStationId: '156518', name: 'British School Jakarta, Pondok Aren', network: 'nafas' },
  { locationSlug: 'bsd', source: 'airgradient', sourceStationId: '156523', name: 'Global Jaya School, Parigi', network: 'nafas' },
  { locationSlug: 'bsd', source: 'airgradient', sourceStationId: '74891', name: 'Ciputat', network: 'nafas' },
  { locationSlug: 'bali-denpasar', source: 'airgradient', sourceStationId: '77247', name: 'Tonja, Denpasar', network: 'nafas' },
  { locationSlug: 'bali-denpasar', source: 'airgradient', sourceStationId: '203332', name: 'Sibang Eco Village', network: null },
  { locationSlug: 'bali-denpasar', source: 'airgradient', sourceStationId: '203333', name: 'Canggu, Padang Linjong', network: null },
] as const;

export const ALL_STATIONS: readonly StationConfig[] = [
  ...WAQI_STATIONS,
  ...DATAGOVSG_STATIONS,
  ...AIRGRADIENT_STATIONS,
] as const;

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
