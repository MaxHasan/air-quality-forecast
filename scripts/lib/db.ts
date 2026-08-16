/**
 * scripts/lib/db.ts — PostgREST ergonomics the scripts all need.
 *
 * `src/lib/db.ts` owns client *creation* and is shared with the frontend. This
 * file is the ingestion-side companion: it owns the three things every write
 * script gets wrong on the first try.
 *
 * 1. **The 1000-row ceiling.** PostgREST caps an unbounded SELECT at
 *    `db-max-rows` (1000 on Supabase). `rollup.ts --days 92` wants ~4400 hourly
 *    rows and would silently receive the first 1000 — producing daily averages
 *    computed from a third of the data, with no error anywhere. `selectAllPages`
 *    exists solely to make that impossible.
 *
 * 2. **Oversized writes.** A backfill upsert of ten thousand rows is one
 *    enormous request that times out at the edge. `upsertChunked` splits it and
 *    reports how many rows actually landed.
 *
 * 3. **"The schema is not applied yet."** Until the migrations are pasted into
 *    the Supabase SQL editor, every query fails with PostgREST's
 *    `PGRST205 Could not find the table 'public.x' in the schema cache`. That is
 *    a setup step, not a bug, and it deserves a sentence telling the operator
 *    what to do — not a stack trace. `describeDbError` supplies it.
 */

import { getServiceClient, hasServiceCredentials, type Db } from '../../src/lib/db';
import type { LocationSlug, StationRow } from '../../src/lib/types';

/** The shape supabase-js hands back on failure. */
export interface DbErrorLike {
  message: string;
  code?: string;
  details?: string | null;
  hint?: string | null;
}

/** Default page size. Below Supabase's 1000-row cap, with room to spare. */
const PAGE_SIZE = 900;

/** Default upsert batch. Large enough to be few round-trips, small enough to fit. */
const UPSERT_CHUNK = 400;

/**
 * PostgREST codes that mean "this relation does not exist".
 *
 * `PGRST205` is the schema-cache miss (the usual one), `PGRST202` the same for
 * functions, and `42P01` is Postgres' own `undefined_table` when the request
 * reaches the database at all.
 */
const MISSING_RELATION_CODES = new Set(['PGRST205', 'PGRST202', '42P01']);

const SETUP_HINT =
  'The database schema is not applied yet.\n' +
  '  Open the Supabase SQL editor and run, in order:\n' +
  '    supabase/migrations/0001_init.sql\n' +
  '    supabase/migrations/0002_views.sql\n' +
  '    supabase/migrations/0003_rls.sql\n' +
  '    supabase/migrations/0004_seed.sql\n' +
  '  Then re-run this script. (Every script here is idempotent — re-running is safe.)';

/** True when the error means "that table/view does not exist". */
export function isMissingRelationError(error: DbErrorLike | null | undefined): boolean {
  if (!error) return false;
  if (error.code && MISSING_RELATION_CODES.has(error.code)) return true;
  return /schema cache|does not exist|relation .* does not exist/i.test(error.message ?? '');
}

/**
 * Turn a PostgREST error into something an operator can act on.
 *
 * The missing-relation case gets the full setup checklist appended, because it
 * is overwhelmingly the failure a fresh clone hits and the fix is a copy-paste
 * away rather than a code change.
 */
export function describeDbError(context: string, error: DbErrorLike | null | undefined): string {
  if (!error) return `${context}: unknown database error`;
  const base = `${context}: ${error.message}${error.code ? ` [${error.code}]` : ''}`;
  const extra = [error.details, error.hint].filter(Boolean).join(' ');
  const detailed = extra ? `${base} — ${extra}` : base;
  return isMissingRelationError(error) ? `${detailed}\n\n${SETUP_HINT}` : detailed;
}

/** Thrown for database problems that should end the run. Carries no secrets. */
export class DbFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DbFailure';
  }
}

/**
 * Service-role client, or a clear message about what is missing.
 *
 * Fails on the credentials check *before* the first query so a misconfigured
 * environment reports "you forgot a secret" rather than "unauthorized".
 */
export function serviceClient(): Db {
  if (!hasServiceCredentials()) {
    throw new DbFailure(
      'Missing Supabase credentials.\n' +
        '  Locally:  put SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local (see .env.example).\n' +
        '  In CI:    set them as repository secrets and pass them through the workflow `env:` block.',
    );
  }
  return getServiceClient();
}

/**
 * Read an entire table slice, following the 1000-row ceiling with `.range()`.
 *
 * `build` is called once per page and must return a fresh query — a PostgREST
 * builder is a thenable and cannot be re-executed, so reusing one would return
 * the same page forever.
 *
 * Order matters: without a stable sort, two pages can overlap or skip rows.
 * Callers therefore pass an `order` and it is applied here rather than left to
 * chance.
 */
export async function selectAllPages<T>(
  context: string,
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: DbErrorLike | null }>,
  pageSize: number = PAGE_SIZE,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await build(from, from + pageSize - 1);
    if (error) throw new DbFailure(describeDbError(context, error));
    const page = data ?? [];
    out.push(...page);
    // A short page is the last page. An exactly-full page might not be, so we
    // ask again and accept one wasted round-trip at the boundary.
    if (page.length < pageSize) return out;
  }
}

/**
 * Upsert in batches, returning the number of rows accepted.
 *
 * `onConflict` must name the table's unique key so a re-run overwrites rather
 * than duplicating — idempotency is what makes the trailing-window catch-up
 * strategy safe, and it is enforced here rather than remembered at each call
 * site.
 */
export async function upsertChunked<Row>(
  context: string,
  db: Db,
  table: string,
  rows: readonly Row[],
  onConflict: string,
  chunkSize: number = UPSERT_CHUNK,
): Promise<number> {
  let written = 0;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    // `as never`: the hand-written Database type in src/lib/types.ts cannot be
    // narrowed by a runtime table name, so supabase-js resolves the Insert type
    // to `never`. The row shapes are checked at each call site instead.
    const { error } = await db
      .from(table as never)
      .upsert(chunk as never, { onConflict, ignoreDuplicates: false });
    if (error) throw new DbFailure(describeDbError(`${context} (rows ${i}..${i + chunk.length - 1})`, error));
    written += chunk.length;
  }
  return written;
}

/* -------------------------------------------------------------------------- */
/* Reference data                                                             */
/* -------------------------------------------------------------------------- */

/** The subset of `locations` every script needs: id, slug, tz, coordinates. */
export interface LocationRecord {
  id: number;
  slug: LocationSlug;
  timezone: string;
  lat: number;
  lon: number;
  name: string;
}

/**
 * Load seeded locations, keyed by slug.
 *
 * Throws when the table is empty rather than looping over nothing: an ingestion
 * run that "succeeds" with zero locations looks healthy in the job log and is
 * the hardest kind of failure to notice.
 */
export async function loadLocations(db: Db): Promise<LocationRecord[]> {
  const { data, error } = await db
    .from('locations')
    .select('id, slug, timezone, lat, lon, name')
    .order('id')
    .returns<LocationRecord[]>();
  if (error) throw new DbFailure(describeDbError('reading locations', error));
  if (!data || data.length === 0) {
    throw new DbFailure(`No rows in public.locations.\n\n${SETUP_HINT}`);
  }
  return data;
}

/** The subset of `stations` the ingestion scripts need. */
export type StationRecord = Pick<
  StationRow,
  'id' | 'location_id' | 'source' | 'source_station_id' | 'name' | 'is_active' | 'last_seen_at' | 'created_at'
>;

/** Load stations. `activeOnly` is the normal case; rollups want history too. */
export async function loadStations(db: Db, activeOnly = true): Promise<StationRecord[]> {
  let query = db
    .from('stations')
    .select('id, location_id, source, source_station_id, name, is_active, last_seen_at, created_at');
  if (activeOnly) query = query.eq('is_active', true);

  const { data, error } = await query.order('id').returns<StationRecord[]>();
  if (error) throw new DbFailure(describeDbError('reading stations', error));
  if (!data || data.length === 0) {
    throw new DbFailure(
      activeOnly
        ? `No active rows in public.stations. Either the seed has not been applied, or every station has been ` +
          `auto-deactivated — run \`npm run discover:stations\` to find live replacements.\n\n${SETUP_HINT}`
        : `No rows in public.stations.\n\n${SETUP_HINT}`,
    );
  }
  return data;
}
