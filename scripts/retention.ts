/**
 * retention.ts — keep the free tier free, without losing the training data.
 *
 * Run:
 *   npm run retention -- --dry-run   # count what would go, change nothing
 *   npm run retention                # actually prune
 *
 * Supabase's free tier caps the database at 500 MB. At eight locations the
 * hourly tables grow by roughly 100k rows a year, and `aq_observations.raw`
 * — a full WAQI payload per station-hour — is by far the largest thing in the
 * database, several hundred bytes for a reading whose useful content is two
 * numbers.
 *
 * Three tiers, in increasing order of regret:
 *
 *   1. `raw` older than 30 days is set to NULL. The payload's only job is to let
 *      us re-derive a reading if a parser turns out to be wrong; after a month
 *      that window has closed. `pm25_ugm3`, `pm25_aqi_us` and `aqi_table` are
 *      untouched, so a wrong breakpoint table is *still* correctable in place
 *      long after `raw` is gone.
 *   2. Hourly rows older than 400 days are deleted. 400 rather than 365 so a
 *      full year-over-year comparison always has both ends.
 *   3. Daily rollups are never deleted. They are the model's training data and
 *      they are tiny — a decade of `daily_aq` for eight locations is under
 *      30,000 rows.
 *
 * Deliberately not scheduled by a workflow. This is the only destructive script
 * in the repo and it should be run deliberately, after looking at the dry run.
 * The database will not be near its cap for years.
 */

import { serviceClient, describeDbError, DbFailure } from './lib/db';
import { hasFlag, intFlag, reportFatal, runJob } from './lib/run-log';

/** Days after which a raw payload has outlived its purpose. */
const RAW_DAYS = 30;

/** Days of hourly history to keep. */
const HOURLY_DAYS = 400;

const iso = (days: number, now: Date): string => new Date(now.getTime() - days * 86_400_000).toISOString();

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = hasFlag(argv, 'dry-run');
  const rawDays = intFlag(argv, 'raw-days', RAW_DAYS);
  const hourlyDays = intFlag(argv, 'hourly-days', HOURLY_DAYS);
  const now = new Date();

  if (hourlyDays <= rawDays) {
    throw new DbFailure(`--hourly-days (${hourlyDays}) must exceed --raw-days (${rawDays}) or the raw pass is pointless`);
  }

  const rawCutoff = iso(rawDays, now);
  const hourlyCutoff = iso(hourlyDays, now);

  await runJob('retention', { dryRun: false, meta: { raw_cutoff: rawCutoff, hourly_cutoff: hourlyCutoff, dry_run: dryRun } }, async (run) => {
    // Note `dryRun: false` above: the run itself is always logged, because
    // knowing that a prune was *considered* is part of the audit trail. What
    // `--dry-run` suppresses is the writes below.
    const db = serviceClient();

    /* -- 1. count first ----------------------------------------------------- */
    /**
     * `head: true` with an exact count is a COUNT(*) that transfers no rows.
     *
     * The `count === null` guard is not defensive padding. Measured on
     * 2026-08-16: a HEAD count against a table that does not exist comes back
     * as **HTTP 204 with `error: null` and `count: null`** — no error to check.
     * Treating that as zero would make this script cheerfully report "nothing
     * to prune" on an unmigrated database, which is the one place a destructive
     * script must not be relaxed about not knowing what it is looking at.
     */
    async function countRows(
      context: string,
      build: () => PromiseLike<{ count: number | null; error: { message: string; code?: string } | null }>,
    ): Promise<number> {
      const { count, error } = await build();
      if (error) throw new DbFailure(describeDbError(context, error));
      if (count === null) {
        throw new DbFailure(
          describeDbError(context, { message: 'the server returned no count — the table is probably absent', code: 'PGRST205' }),
        );
      }
      return count;
    }

    const rawCount = await countRows('counting raw payloads to null', () =>
      db
        .from('aq_observations')
        .select('*', { count: 'exact', head: true })
        .lt('observed_at', rawCutoff)
        .not('raw', 'is', null),
    );
    const aqCount = await countRows('counting expired aq_observations', () =>
      db.from('aq_observations').select('*', { count: 'exact', head: true }).lt('observed_at', hourlyCutoff),
    );
    const wxCount = await countRows('counting expired weather_observations', () =>
      db.from('weather_observations').select('*', { count: 'exact', head: true }).lt('observed_at', hourlyCutoff),
    );

    console.log(`  raw payloads older than ${rawDays}d to null  : ${rawCount}`);
    console.log(`  aq_observations older than ${hourlyDays}d     : ${aqCount}`);
    console.log(`  weather_observations older than ${hourlyDays}d: ${wxCount}`);
    console.log('  daily_aq / daily_weather                   : kept forever (training data)');

    run.note({ raw_to_null: rawCount, aq_to_delete: aqCount, weather_to_delete: wxCount });

    if (dryRun) {
      console.log('\n[dry run] nothing was changed. Re-run without --dry-run to prune.');
      return;
    }

    /* -- 2. null old raw payloads ------------------------------------------- */
    if (rawCount > 0) {
      const { error } = await db
        .from('aq_observations')
        .update({ raw: null } as never)
        .lt('observed_at', rawCutoff)
        .not('raw', 'is', null);
      if (error) throw new DbFailure(describeDbError('nulling old raw payloads', error));
      run.upserted(rawCount);
    }

    /* -- 3. delete expired hourly rows -------------------------------------- */
    if (aqCount > 0) {
      const { error } = await db.from('aq_observations').delete().lt('observed_at', hourlyCutoff);
      if (error) throw new DbFailure(describeDbError('deleting expired aq_observations', error));
    }
    if (wxCount > 0) {
      const { error } = await db.from('weather_observations').delete().lt('observed_at', hourlyCutoff);
      if (error) throw new DbFailure(describeDbError('deleting expired weather_observations', error));
    }

    console.log(`\n  pruned. Daily rollups untouched.`);
  });
}

main().catch(reportFatal);
