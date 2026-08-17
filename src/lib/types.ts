/**
 * types.ts — the contract mirror.
 *
 * Every type here corresponds 1:1 to something in `supabase/migrations/`.
 * It is the boundary between the ingestion workstream (scripts/, writes) and
 * the frontend workstream (src/app/, reads): both compile against this file, so
 * a schema change that is not reflected here breaks the build rather than
 * production.
 *
 * Rules of the road
 *  - Column names are snake_case, matching Postgres exactly. Do not camelCase
 *    row types; PostgREST returns raw column names.
 *  - `timestamptz` arrives as an ISO-8601 string (`IsoTimestamp`), never a Date.
 *  - `date` arrives as `YYYY-MM-DD` (`LocalDate`) and is always the calendar
 *    date in the *location's* timezone (see src/lib/format.ts).
 *  - Nullable columns are `T | null`, never `T | undefined`.
 *  - `*Insert` types drop generated/defaulted columns; they are what the
 *    ingestion scripts hand to `.upsert()`.
 *
 * Changes after milestone M1 require a migration in the same commit.
 */

/* -------------------------------------------------------------------------- */
/* Primitives                                                                 */
/* -------------------------------------------------------------------------- */

/** JSON value as returned by PostgREST for a `jsonb` column. */
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

/** `YYYY-MM-DD` in a location's local timezone. Never a UTC date. */
export type LocalDate = string;

/** ISO-8601 instant with offset, e.g. `2026-08-16T09:00:00+00:00`. Always UTC in the DB. */
export type IsoTimestamp = string;

/** IANA timezone id. Only three occur in v1. */
export type TimeZone = 'Asia/Jakarta' | 'Asia/Makassar' | 'Asia/Singapore';

/** ISO 3166-1 alpha-2, constrained to the countries we cover. */
export type CountryCode = 'ID' | 'SG';

/** Seeded location slugs. Adding one means a migration + a `stations.ts` entry. */
export type LocationSlug =
  | 'jakarta-central'
  | 'bsd'
  | 'bali-denpasar'
  | 'sg-central'
  | 'sg-north'
  | 'sg-south'
  | 'sg-east'
  | 'sg-west';

/** Where a PM2.5 feed comes from. */
export type AqSource = 'waqi' | 'datagovsg';

/** Upstream sensor network behind a WAQI feed (`null` when unconfirmed). */
export type StationNetwork = 'nafas' | 'bmkg' | 'klhk' | 'nea';

/** Weather provider. `openmeteo` is the only one wired in v1. */
export type WeatherSource = 'openmeteo' | 'datagovsg' | 'bmkg';

/** US-EPA PM2.5 breakpoint table id — see src/lib/aqi.ts. */
export type AqiTableId = 'epa-pre-2024' | 'epa-2024';

/**
 * The three competing predictors. Order matters: it is the cold-start
 * preference used when `model_accuracy` has too few scored days (n < 7) to pick
 * a winner on MAE.
 */
export type ModelName = 'wind_regression' | 'cams' | 'persistence';

/** Cold-start fallback order for the headline model. */
export const MODEL_FALLBACK_ORDER: readonly ModelName[] = ['wind_regression', 'cams', 'persistence'] as const;

/** Prediction horizon in days ahead of the issue date. */
export type HorizonDays = 1 | 2 | 3;

/** Scheduled job names written to `ingestion_runs.job`. */
export type JobName =
  | 'ingest-aq'
  | 'ingest-weather'
  | 'rollup'
  | 'predict'
  | 'backfill'
  | 'retention'
  | 'calibrate'
  | 'keepalive';

/** `partial` = some stations failed but the run still produced data. */
export type RunStatus = 'running' | 'ok' | 'partial' | 'error';

/* -------------------------------------------------------------------------- */
/* Table rows — 0001_init.sql                                                 */
/* -------------------------------------------------------------------------- */

/** `public.locations` */
export interface LocationRow {
  id: number;
  slug: LocationSlug;
  name: string;
  country: CountryCode;
  /** Drives every `local_date` bucket. Bali is `Asia/Makassar`. */
  timezone: TimeZone;
  lat: number;
  lon: number;
  created_at: IsoTimestamp;
}

export type LocationInsert = Omit<LocationRow, 'id' | 'created_at'> & { created_at?: IsoTimestamp };

/** `public.stations` */
export interface StationRow {
  id: number;
  location_id: number;
  source: AqSource;
  /** WAQI: numeric uid without the `@`. data.gov.sg: region name. */
  source_station_id: string;
  name: string;
  network: StationNetwork | null;
  lat: number | null;
  lon: number | null;
  is_active: boolean;
  /** Newest observation seen. Feeds >6h stale are skipped, >14d are deactivated. */
  last_seen_at: IsoTimestamp | null;
  created_at: IsoTimestamp;
}

export type StationInsert = Omit<StationRow, 'id' | 'created_at' | 'is_active' | 'last_seen_at'> &
  Partial<Pick<StationRow, 'is_active' | 'last_seen_at' | 'created_at'>>;

/**
 * `public.aq_observations` — hourly ground truth.
 *
 * WAQI publishes `iaqi.pm25.v` as a US-EPA AQI *sub-index*, not µg/m³. Both the
 * raw index and the inverted concentration are stored, together with the
 * breakpoint table used, so a wrong table can be corrected in place.
 */
export interface AqObservationRow {
  station_id: number;
  observed_at: IsoTimestamp;
  pm25_ugm3: number | null;
  pm25_aqi_us: number | null;
  aqi_table: AqiTableId | null;
  raw: Json | null;
  ingested_at: IsoTimestamp;
}

export type AqObservationInsert = Omit<AqObservationRow, 'ingested_at'> & { ingested_at?: IsoTimestamp };

/** `public.weather_observations` — hourly, per location and provider. */
export interface WeatherObservationRow {
  location_id: number;
  observed_at: IsoTimestamp;
  source: WeatherSource;
  temp_c: number | null;
  wind_speed_ms: number | null;
  /** Meteorological convention: the direction the wind blows *from*. */
  wind_dir_deg: number | null;
  wind_gusts_ms: number | null;
  rh_pct: number | null;
  precip_mm: number | null;
  /** Boundary-layer height, m. Dilution volume proxy. */
  blh_m: number | null;
  ingested_at: IsoTimestamp;
}

export type WeatherObservationInsert = Omit<WeatherObservationRow, 'ingested_at'> & {
  ingested_at?: IsoTimestamp;
};

/** `public.daily_aq` — rollup table keyed on the location's local date. */
export interface DailyAqRow {
  location_id: number;
  local_date: LocalDate;
  pm25_avg: number;
  pm25_min: number | null;
  pm25_max: number | null;
  /** Distinct local hours with data (1..24). Scoring requires >= 12. */
  hours_count: number;
  station_count: number;
  computed_at: IsoTimestamp;
}

export type DailyAqInsert = Omit<DailyAqRow, 'computed_at'> & { computed_at?: IsoTimestamp };

/** `public.daily_weather` — rollup table. Direction is vector-averaged. */
export interface DailyWeatherRow {
  location_id: number;
  local_date: LocalDate;
  source: WeatherSource;
  temp_avg_c: number | null;
  temp_min_c: number | null;
  temp_max_c: number | null;
  /** The predictor the whole model rests on. */
  wind_speed_avg_ms: number | null;
  wind_speed_max_ms: number | null;
  /** Circular mean of hourly direction — a scalar mean would erase the signal. */
  wind_dir_vector_deg: number | null;
  /** Resultant length 0..1. Near 0 means the daily direction is meaningless. */
  wind_dir_consistency: number | null;
  rh_avg_pct: number | null;
  precip_mm_total: number | null;
  blh_avg_m: number | null;
  hours_count: number;
  computed_at: IsoTimestamp;
}

export type DailyWeatherInsert = Omit<DailyWeatherRow, 'computed_at'> & { computed_at?: IsoTimestamp };

/**
 * Predictor slopes, keyed by the quantity they multiply, so `predict.ts` looks
 * them up by name rather than by position — a coefficient set fitted with a
 * different predictor list stays readable instead of being silently misapplied.
 *
 * Known predictor names:
 *   `wind_speed_avg_ms`  daily-mean 10 m wind for the target day, m/s (always
 *                        present; a negative slope is the model's whole premise)
 *   `pm25_lag`           the most recent observed daily mean, µg/m³ — the
 *                        persistence anchor the shipped specification leans on
 *   `temp_avg_c`         daily-mean temperature, °C (the earlier weather-only
 *                        specification; retained so older versions still load)
 *
 * Only the wind term is required. See scripts/calibrate/fit-wind-model.ts for
 * why the shipped model pairs it with the lag rather than with temperature.
 */
export interface ModelCoefficientMap {
  wind_speed_avg_ms: number;
  pm25_lag?: number;
  temp_avg_c?: number;
  [predictor: string]: number | undefined;
}

/** Fit quality + provenance stored on `model_coefficients.stats`. */
export interface ModelFitStats {
  r2: number;
  n: number;
  rmse: number;
  /** Inclusive local-date bounds of the training window. */
  period_start?: LocalDate;
  period_end?: LocalDate;
  /** e.g. `nafas-bmkg-2022-2023` (build-time fit) or `daily_aq` (in-DB refit). */
  source?: string;
  [key: string]: Json | undefined;
}

/** `public.model_coefficients` — versioned; at most one active per (location, model). */
export interface ModelCoefficientsRow {
  id: number;
  location_id: number;
  model: 'wind_regression';
  version: number;
  intercept: number;
  coef: ModelCoefficientMap;
  stats: ModelFitStats;
  is_active: boolean;
  fitted_at: IsoTimestamp;
}

export type ModelCoefficientsInsert = Omit<ModelCoefficientsRow, 'id' | 'fitted_at' | 'is_active'> &
  Partial<Pick<ModelCoefficientsRow, 'is_active' | 'fitted_at'>>;

/** What went into a prediction — recorded for post-hoc debugging of bad calls. */
export interface PredictionInputs {
  /** Daily-mean wind used (m/s). */
  wind_speed_avg_ms?: number;
  /** Daily-mean temperature used (°C). */
  temp_avg_c?: number;
  /** For horizon 1: how many hours came from observations rather than forecast. */
  observed_hours?: number;
  /** Forecast issue time of the upstream model run. */
  forecast_run_at?: IsoTimestamp;
  /** `persistence` only: the local date whose actual was carried forward. */
  source_date?: LocalDate;
  /** Set when the regression's raw output was negative and got clamped to 0. */
  clamped?: boolean;
  [key: string]: Json | undefined;
}

/** `public.predictions` — unique on (location, target_date, model, horizon). */
export interface PredictionRow {
  id: number;
  location_id: number;
  /** Local date being predicted. */
  target_date: LocalDate;
  horizon_days: HorizonDays;
  model: ModelName;
  /** µg/m³, clamped at 0 by predict.ts. */
  predicted_pm25: number;
  coefficients_id: number | null;
  inputs: PredictionInputs;
  run_at: IsoTimestamp;
}

export type PredictionInsert = Omit<PredictionRow, 'id' | 'run_at'> & { run_at?: IsoTimestamp };

/** `public.ingestion_runs` — job log. */
export interface IngestionRunRow {
  id: number;
  job: JobName;
  started_at: IsoTimestamp;
  finished_at: IsoTimestamp | null;
  status: RunStatus;
  rows_upserted: number;
  error: string | null;
  meta: Json;
}

export type IngestionRunInsert = Omit<IngestionRunRow, 'id' | 'started_at' | 'status' | 'rows_upserted'> &
  Partial<Pick<IngestionRunRow, 'started_at' | 'status' | 'rows_upserted'>>;

/** `public.push_subscriptions` — v2 only; nothing reads or writes this in v1. */
export interface PushSubscriptionRow {
  id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  location_id: number | null;
  activity: ActivityKey | null;
  threshold_pm25: number | null;
  user_agent: string | null;
  created_at: IsoTimestamp;
  last_notified_at: IsoTimestamp | null;
}

export type PushSubscriptionInsert = Omit<PushSubscriptionRow, 'id' | 'created_at' | 'last_notified_at'> &
  Partial<Pick<PushSubscriptionRow, 'created_at' | 'last_notified_at'>>;

/* -------------------------------------------------------------------------- */
/* View rows — 0002_views.sql                                                 */
/* -------------------------------------------------------------------------- */

/** `public.prediction_scores` — predictions joined to actuals (>=12h coverage). */
export interface PredictionScoreRow {
  prediction_id: number;
  location_id: number;
  location_slug: LocationSlug;
  target_date: LocalDate;
  horizon_days: HorizonDays;
  model: ModelName;
  predicted_pm25: number;
  actual_pm25: number;
  /** Signed: positive means the model over-predicted. */
  error: number;
  abs_error: number;
  squared_error: number;
  actual_hours_count: number;
  run_at: IsoTimestamp;
}

/** `public.model_accuracy` — rolling 30-day skill per location × model × horizon. */
export interface ModelAccuracyRow {
  location_id: number;
  location_slug: LocationSlug;
  model: ModelName;
  horizon_days: HorizonDays;
  n: number;
  mae: number;
  rmse: number;
  /** Mean signed error — systematic over/under-prediction. */
  bias: number;
  first_scored_date: LocalDate;
  last_scored_date: LocalDate;
}

/* -------------------------------------------------------------------------- */
/* Activity verdicts — mirrored from src/lib/thresholds.ts                    */
/* -------------------------------------------------------------------------- */

/** Activities the dashboard gives a verdict for. */
export type ActivityKey = 'newborn_walk' | 'running' | 'swimming';

/** Traffic-light verdict for an activity at a given PM2.5. */
export type Verdict = 'go' | 'caution' | 'avoid';

/* -------------------------------------------------------------------------- */
/* Supabase client typing                                                     */
/* -------------------------------------------------------------------------- */

type Rel = [];

/**
 * Shape expected by `createClient<Database>()`. Hand-written rather than
 * generated (`supabase gen types`) because the project must compile before the
 * Supabase project exists; regenerate later only if it stays consistent with
 * the row types above.
 */
export interface Database {
  public: {
    Tables: {
      locations: { Row: LocationRow; Insert: LocationInsert; Update: Partial<LocationInsert>; Relationships: Rel };
      stations: { Row: StationRow; Insert: StationInsert; Update: Partial<StationInsert>; Relationships: Rel };
      aq_observations: {
        Row: AqObservationRow;
        Insert: AqObservationInsert;
        Update: Partial<AqObservationInsert>;
        Relationships: Rel;
      };
      weather_observations: {
        Row: WeatherObservationRow;
        Insert: WeatherObservationInsert;
        Update: Partial<WeatherObservationInsert>;
        Relationships: Rel;
      };
      daily_aq: { Row: DailyAqRow; Insert: DailyAqInsert; Update: Partial<DailyAqInsert>; Relationships: Rel };
      daily_weather: {
        Row: DailyWeatherRow;
        Insert: DailyWeatherInsert;
        Update: Partial<DailyWeatherInsert>;
        Relationships: Rel;
      };
      model_coefficients: {
        Row: ModelCoefficientsRow;
        Insert: ModelCoefficientsInsert;
        Update: Partial<ModelCoefficientsInsert>;
        Relationships: Rel;
      };
      predictions: {
        Row: PredictionRow;
        Insert: PredictionInsert;
        Update: Partial<PredictionInsert>;
        Relationships: Rel;
      };
      ingestion_runs: {
        Row: IngestionRunRow;
        Insert: IngestionRunInsert;
        Update: Partial<IngestionRunInsert>;
        Relationships: Rel;
      };
      push_subscriptions: {
        Row: PushSubscriptionRow;
        Insert: PushSubscriptionInsert;
        Update: Partial<PushSubscriptionInsert>;
        Relationships: Rel;
      };
    };
    Views: {
      prediction_scores: { Row: PredictionScoreRow; Relationships: Rel };
      model_accuracy: { Row: ModelAccuracyRow; Relationships: Rel };
    };
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}

/* -------------------------------------------------------------------------- */
/* Upstream API shapes                                                        */
/*                                                                            */
/* Only the fields the ingestion scripts actually read are typed, and every    */
/* one of them is optional: these are third-party payloads, so the parsers     */
/* must treat missing fields as normal rather than exceptional.                */
/* -------------------------------------------------------------------------- */

/** One `iaqi` entry: `{ v: <number> }`. For pm25 the value is an AQI sub-index. */
export interface WaqiIaqiValue {
  v: number;
}

/** `GET https://api.waqi.info/feed/@{uid}/?token=` */
export interface WaqiFeedResponse {
  status: 'ok' | 'error';
  /** Error string when `status === 'error'`, otherwise the payload. */
  data:
    | string
    | {
        idx: number;
        /** Overall AQI (dominant pollutant), not necessarily PM2.5. */
        aqi: number | '-';
        time?: {
          /** Station-local time, no offset — prefer `iso`. */
          s?: string;
          tz?: string;
          /** Unix seconds. */
          v?: number;
          /** ISO-8601 with offset. The one to trust for freshness checks. */
          iso?: string;
        };
        city?: { name?: string; geo?: [number, number]; url?: string };
        attributions?: { url?: string; name?: string; logo?: string }[];
        iaqi?: {
          /** AQI sub-index for PM2.5 — invert with src/lib/aqi.ts. */
          pm25?: WaqiIaqiValue;
          pm10?: WaqiIaqiValue;
          t?: WaqiIaqiValue;
          w?: WaqiIaqiValue;
          h?: WaqiIaqiValue;
          [key: string]: WaqiIaqiValue | undefined;
        };
        /** ~8 days of CAMS-derived daily min/avg/max, in AQI units. Unused in v1. */
        forecast?: {
          daily?: {
            pm25?: { day: string; avg: number; min: number; max: number }[];
            [pollutant: string]: { day: string; avg: number; min: number; max: number }[] | undefined;
          };
        };
      };
}

/** `GET https://api.waqi.info/search/?keyword=&token=` — used by discover-stations.ts. */
export interface WaqiSearchResponse {
  status: 'ok' | 'error';
  data: {
    uid: number;
    aqi: string;
    time: { tz?: string; stime?: string; vtime?: number };
    station: { name: string; geo: [number, number]; url?: string; country?: string };
  }[];
}

/** data.gov.sg region names, doubling as `stations.source_station_id`. */
export type SgRegionName = 'north' | 'south' | 'east' | 'west' | 'central';

/**
 * `GET https://api-open.data.gov.sg/v2/real-time/api/pm25?date=YYYY-MM-DD`
 * (v1 is deprecated). Concentrations are native µg/m³ — no AQI inversion.
 */
export interface DataGovSgPm25Response {
  code: number;
  errorMsg?: string;
  data?: {
    regionMetadata?: {
      name: SgRegionName;
      labelLocation: { latitude: number; longitude: number };
    }[];
    items?: {
      /** ISO-8601 with +08:00 offset. */
      timestamp: string;
      updatedTimestamp?: string;
      readings?: {
        pm25_one_hourly?: Record<SgRegionName, number>;
      };
    }[];
    paginationToken?: string;
  };
}

/**
 * `GET https://api.open-meteo.com/v1/forecast` with
 * `hourly=temperature_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,
 *  relative_humidity_2m,precipitation,boundary_layer_height`
 * and `wind_speed_unit=ms`, `timezone=UTC`, `past_days=2`.
 *
 * Arrays are parallel to `hourly.time`.
 */
export interface OpenMeteoWeatherResponse {
  latitude: number;
  longitude: number;
  utc_offset_seconds: number;
  timezone: string;
  hourly?: {
    time: string[];
    temperature_2m?: (number | null)[];
    wind_speed_10m?: (number | null)[];
    wind_direction_10m?: (number | null)[];
    wind_gusts_10m?: (number | null)[];
    relative_humidity_2m?: (number | null)[];
    precipitation?: (number | null)[];
    boundary_layer_height?: (number | null)[];
  };
  hourly_units?: Record<string, string>;
  error?: boolean;
  reason?: string;
}

/**
 * `GET https://air-quality-api.open-meteo.com/v1/air-quality` with
 * `hourly=pm2_5`. CAMS global, 40 km grid — coarse by design; the wind
 * regression exists to fill that gap.
 */
export interface OpenMeteoAirQualityResponse {
  latitude: number;
  longitude: number;
  utc_offset_seconds: number;
  timezone: string;
  hourly?: {
    time: string[];
    /** µg/m³. */
    pm2_5?: (number | null)[];
  };
  error?: boolean;
  reason?: string;
}

/* -------------------------------------------------------------------------- */
/* Frontend composites                                                        */
/*                                                                            */
/* These are assembled in RSC from the rows above; M2B builds its mock         */
/* fixtures to exactly these shapes so M4 is a data-source swap, not a         */
/* rewrite.                                                                   */
/* -------------------------------------------------------------------------- */

/** One model's call for one target date, plus its recent skill. */
export interface ModelPrediction {
  model: ModelName;
  predicted_pm25: number;
  horizon_days: HorizonDays;
  /** Rolling 30-day MAE at this horizon; null while `n < 7` ("calibrating"). */
  mae: number | null;
  /** Scored days behind `mae`. */
  n: number;
}

/** A location's card on `/`: the headline call plus the full model strip. */
export interface LocationForecast {
  location: LocationRow;
  target_date: LocalDate;
  /** Winner by lowest MAE at horizon 1 (n >= 7), else MODEL_FALLBACK_ORDER. */
  headline: ModelPrediction | null;
  /** Every model that produced a call, in MODEL_FALLBACK_ORDER. */
  models: ModelPrediction[];
  /** Latest observed daily average, for "today vs tomorrow". */
  latest_actual: DailyAqRow | null;
  /**
   * The call that was issued *for today* (on an earlier evening, lowest horizon
   * available), selected by the same winner rule as `headline`.
   *
   * Rendered beside tomorrow's number so the card reads as level-and-direction
   * ("33 today → 30 tomorrow") rather than a lone figure — and, placed next to
   * `latest_actual`, it lets the reader eyeball forecast-versus-reality every
   * day, long before /models has accumulated enough scored days to say it
   * formally. Null until the pipeline has produced a prediction targeting the
   * current local date.
   */
  today_prediction: ModelPrediction | null;
  /** True when no model has enough scored days yet — UI shows "calibrating". */
  calibrating: boolean;
}

/** Verdict for one activity, ready to render as a badge. */
export interface ActivityVerdict {
  activity: ActivityKey;
  label: string;
  verdict: Verdict;
  pm25: number;
}

/** A point on the `/location/[slug]` hourly chart (PM2.5 with wind overlay). */
export interface HourlyPoint {
  /** UTC instant. */
  observed_at: IsoTimestamp;
  /** Local hour label, pre-formatted server-side to avoid client tz drift. */
  local_label: string;
  pm25_ugm3: number | null;
  wind_speed_ms: number | null;
}

/** A point on the daily history + forecast-fan chart. */
export interface DailyPoint {
  local_date: LocalDate;
  actual_pm25: number | null;
  wind_speed_avg_ms: number | null;
  /** Present only for future dates; keyed by model. */
  predicted: Partial<Record<ModelName, number>>;
}

/** Ingestion health for the footer. */
export interface IngestionHealth {
  last_ok_at: IsoTimestamp | null;
  /** Consecutive non-ok runs of the most recent job. */
  failure_streak: number;
  latest: IngestionRunRow | null;
}
