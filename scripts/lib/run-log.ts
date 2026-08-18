/**
 * run-log.ts — every scheduled job's frame.
 *
 * A run opens a row in `ingestion_runs`, does its work, and closes the row with
 * a status, a row count and whatever it learned along the way. The PWA footer
 * reads the tail of that table to show "last updated" and a failure streak, so
 * the discipline here is what makes silent decay visible.
 *
 * ---------------------------------------------------------------------------
 * The status rule, which is the whole point
 * ---------------------------------------------------------------------------
 * These jobs fan out over stations and locations that fail *independently*: a
 * WAQI feed goes quiet, one Open-Meteo call times out. Treating any of that as
 * fatal would mean a single dead sensor blocks seven healthy locations from
 * being ingested, which is exactly backwards.
 *
 *   ok       nothing failed
 *   partial  some scoped units failed, but the run still persisted rows
 *   error    the run persisted nothing, or hit a failure that is not scoped to
 *            one unit (no credentials, missing schema, a bad argument)
 *
 * Only `error` exits non-zero. `partial` is a normal Tuesday and must not turn
 * a workflow red — a red badge that is always red stops being read.
 *
 * The "persisted nothing *and* something failed" case is deliberately `error`:
 * a run where every station failed is an outage wearing a partial's clothes.
 * A run that legitimately writes nothing and has no failures (every feed was
 * stale, say) stays `ok`, with the reason recorded in `meta`.
 *
 * ---------------------------------------------------------------------------
 * Detached mode
 * ---------------------------------------------------------------------------
 * If the run row cannot be opened the job does not abort. It logs loudly and
 * continues *detached*, still doing its work and still returning the right exit
 * code. Losing the audit row should not also lose the data — and during initial
 * setup, before the schema exists, this is what lets `--dry-run` exercise the
 * live API paths end to end.
 */

import type { Db } from '../../src/lib/db';
import type { IngestionRunInsert, Json, JobName, RunStatus } from '../../src/lib/types';
import { DbFailure, describeDbError, serviceClient } from './db';
import { redactSecrets } from './http';

/** A failure scoped to one unit of work — one station, one location. */
export interface ScopedFailure {
  /** Human-readable unit id, e.g. `waqi:@8294` or `location:bsd`. */
  scope: string;
  /** Already redacted. */
  message: string;
}

export interface RunOptions {
  /** Skip every database read and write. Used to exercise the API paths alone. */
  dryRun?: boolean;
  /** Seed values for `ingestion_runs.meta`. */
  meta?: Record<string, Json>;
}

/**
 * The handle a job body works against.
 *
 * Everything here is synchronous and non-throwing except `finish`, so a job
 * never has to decide whether recording a failure could itself fail.
 */
export class RunLog {
  readonly job: JobName;
  readonly dryRun: boolean;
  readonly startedAt = new Date();

  private rows = 0;
  private readonly failures: ScopedFailure[] = [];
  private readonly metaBag: Record<string, Json>;
  private hardError: string | null = null;

  /** `null` while detached (row not opened, or dry run). */
  private runId: number | null = null;
  private db: Db | null = null;

  constructor(job: JobName, options: RunOptions = {}) {
    this.job = job;
    this.dryRun = options.dryRun ?? false;
    this.metaBag = { ...(options.meta ?? {}) };
    if (this.dryRun) this.metaBag.dry_run = true;
  }

  /** Rows this run persisted (or would have, in a dry run). */
  get rowsUpserted(): number {
    return this.rows;
  }

  get failureCount(): number {
    return this.failures.length;
  }

  /** Count rows written. Called after each successful upsert, not before. */
  upserted(n: number): void {
    if (Number.isFinite(n) && n > 0) this.rows += n;
  }

  /** Merge keys into `meta`. Later calls win. */
  note(values: Record<string, Json>): void {
    Object.assign(this.metaBag, values);
  }

  /**
   * Record a failure scoped to one unit and keep going.
   *
   * Prints immediately: in a GitHub Actions log the interleaving with progress
   * output is what tells you *when* in the run it went wrong.
   */
  failed(scope: string, err: unknown): void {
    const message = redactSecrets(err instanceof Error ? err.message : String(err));
    this.failures.push({ scope, message });
    console.error(`  ✗ ${scope}: ${message}`);
  }

  /** Record a failure that ends the run. */
  fatal(err: unknown): void {
    this.hardError = redactSecrets(err instanceof Error ? err.message : String(err));
  }

  /** Status this run would close with right now. */
  status(): RunStatus {
    if (this.hardError) return 'error';
    if (this.failures.length === 0) return 'ok';
    return this.rows > 0 ? 'partial' : 'error';
  }

  /**
   * Open the `ingestion_runs` row. Never throws: a logging failure is not a job
   * failure, so a problem here downgrades to detached mode and is reported at
   * the end instead.
   */
  async open(): Promise<void> {
    if (this.dryRun) {
      console.log(`[${this.job}] dry run — no database reads or writes`);
      return;
    }

    try {
      this.db = serviceClient();
    } catch (err) {
      // No credentials is not a logging problem, it is a setup problem, and the
      // job cannot do anything useful without them.
      throw err instanceof DbFailure ? err : new DbFailure(String(err));
    }

    const row: IngestionRunInsert = {
      job: this.job,
      finished_at: null,
      status: 'running',
      error: null,
      meta: this.metaBag as Json,
    };

    // `as never` on the payload, and an explicit cast on the result: the
    // hand-written Database type in src/lib/types.ts cannot be threaded through
    // supabase-js's insert-and-return inference, which collapses to `never`.
    // Same accommodation as scripts/calibrate/fit-wind-model.ts.
    const { data, error } = (await this.db
      .from('ingestion_runs')
      .insert(row as never)
      .select('id')
      .single()) as { data: { id: number } | null; error: { message: string; code?: string } | null };

    if (error) {
      console.error(`[${this.job}] could not open a run row — continuing detached.`);
      console.error(`  ${describeDbError('inserting into ingestion_runs', error)}`);
      return;
    }
    this.runId = data?.id ?? null;
  }

  /**
   * Close the row and return the process exit code.
   *
   * Always writes a terminal status if a row was opened, including after a
   * fatal error — a row left in `running` forever is worse than no row, because
   * the footer would report the job as in flight indefinitely.
   */
  async finish(): Promise<number> {
    const status = this.status();
    const finishedAt = new Date();
    const seconds = (finishedAt.getTime() - this.startedAt.getTime()) / 1000;

    if (this.failures.length > 0) {
      this.metaBag.failures = this.failures.map((f) => `${f.scope}: ${f.message}`);
      this.metaBag.failure_count = this.failures.length;
    }
    this.metaBag.duration_s = Number(seconds.toFixed(1));

    // `error` carries the fatal message when there is one, otherwise a summary
    // of the scoped failures — so a `partial` row still says what went wrong
    // without anyone having to open `meta`.
    const errorText = this.hardError
      ? this.hardError
      : this.failures.length > 0
        ? `${this.failures.length} scoped failure(s): ${this.failures.map((f) => f.scope).join(', ')}`
        : null;

    if (this.db && this.runId !== null) {
      const { error } = await this.db
        .from('ingestion_runs')
        .update({
          finished_at: finishedAt.toISOString(),
          status,
          rows_upserted: this.rows,
          error: errorText ? errorText.slice(0, 4000) : null,
          meta: this.metaBag as Json,
        } as never)
        .eq('id', this.runId);
      if (error) console.error(`  ${describeDbError('closing the ingestion_runs row', error)}`);
    }

    const symbol = status === 'ok' ? '✓' : status === 'partial' ? '~' : '✗';
    console.log(
      `${symbol} [${this.job}] ${status} — ${this.rows} row(s), ` +
        `${this.failures.length} failure(s), ${seconds.toFixed(1)}s${this.runId === null ? ' (detached)' : ''}`,
    );
    if (this.hardError) console.error(`  ${this.hardError}`);

    return status === 'error' ? 1 : 0;
  }
}

/**
 * Run a job body inside the frame above.
 *
 * Sets `process.exitCode` rather than calling `process.exit`, so that pending
 * stdout writes flush — `process.exit` truncates them, which is how a CI log
 * ends up missing the very line that explains the failure.
 */
export async function runJob(
  job: JobName,
  options: RunOptions,
  body: (run: RunLog) => Promise<void>,
): Promise<void> {
  const run = new RunLog(job, options);

  try {
    await run.open();
  } catch (err) {
    // Credentials or an equivalent precondition. There is no row to close.
    console.error(`✗ [${job}] error`);
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  try {
    await body(run);
  } catch (err) {
    run.fatal(err);
    // The stack is genuinely useful for a bug in our own code, but a DbFailure
    // is an operator-facing message and its stack is noise.
    if (!(err instanceof DbFailure) && err instanceof Error && err.stack) {
      console.error(redactSecrets(err.stack));
    }
  }

  process.exitCode = await run.finish();
}

/**
 * Terminal handler for a script's `main()`.
 *
 * Argument parsing and credential checks happen *before* `runJob` can open a
 * run row, so those failures have no frame to be caught by. Without this they
 * surface as an unhandled rejection and a Node stack trace, which buries the
 * one line that says what to type instead. A `DbFailure` is an operator-facing
 * message and prints alone; anything else keeps its stack, because an unexpected
 * exception is a bug in this repo and the stack is the useful part.
 */
export function reportFatal(err: unknown): void {
  if (err instanceof DbFailure) {
    console.error(`✗ ${err.message}`);
  } else {
    console.error(redactSecrets(err instanceof Error ? (err.stack ?? err.message) : String(err)));
  }
  process.exitCode = 1;
}

/** `--dry-run` / `--days N` style argument parsing, shared by every script. */
export function hasFlag(argv: readonly string[], flag: string): boolean {
  return argv.includes(`--${flag}`);
}

/**
 * Read `--name value` or `--name=value` as a positive integer.
 *
 * Returns the fallback for a missing flag, but throws for a *present but
 * unparseable* one: `--days banana` silently becoming `--days 3` is how a
 * backfill quietly does nothing.
 */
/**
 * Read `--name=value` (or `--name value`) as a string, or `fallback`.
 *
 * Returns the fallback for a present-but-empty flag, so `--only=` behaves like
 * "not specified" rather than selecting a source called "".
 */
export function stringFlag(argv: readonly string[], flag: string, fallback: string | null): string | null {
  const prefixed = `--${flag}=`;
  for (const [i, arg] of argv.entries()) {
    if (arg.startsWith(prefixed)) {
      const value = arg.slice(prefixed.length).trim();
      return value === '' ? fallback : value;
    }
    if (arg === `--${flag}`) {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) return next.trim() || fallback;
      return fallback;
    }
  }
  return fallback;
}

export function intFlag(argv: readonly string[], flag: string, fallback: number): number {
  const idx = argv.findIndex((a) => a === `--${flag}` || a.startsWith(`--${flag}=`));
  if (idx === -1) return fallback;

  const raw = argv[idx].includes('=') ? argv[idx].split('=').slice(1).join('=') : argv[idx + 1];
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new DbFailure(`--${flag} expects a positive integer, got ${JSON.stringify(raw ?? '(nothing)')}`);
  }
  return n;
}
