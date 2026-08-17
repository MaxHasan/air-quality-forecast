/**
 * headline.ts — picks the "winning" model for a location card.
 *
 * The rule is documented on `LocationForecast.headline` in `src/lib/types.ts`:
 * lowest 30-day MAE at horizon 1 among models with enough scored days to trust
 * (`n >= MIN_SCORED_DAYS_FOR_RANKING`), falling back to `MODEL_FALLBACK_ORDER`
 * when nothing qualifies yet (cold start / calibrating).
 *
 * Pulled out as a standalone pure function — rather than inlined in
 * `mock-data.ts` — because M4 (mocks → live reads) needs the identical rule
 * applied to real `model_accuracy` rows; this file has no dependency on
 * whether the data came from a fixture or Postgres, so it can be reused as-is.
 */

import { MODEL_FALLBACK_ORDER } from './types';
import type { ModelPrediction } from './types';
import { MIN_SCORED_DAYS_FOR_RANKING } from './stations';

/**
 * Ranks whatever the caller hands it, rather than filtering to horizon 1.
 *
 * The caller has already chosen one row per model for the target date — the
 * lowest horizon available (see `buildModelPredictions` in queries.ts) — so by
 * the time the list arrives here, every entry is the best call that exists for
 * that day. Re-filtering to `horizon_days === 1` here discarded the whole list
 * whenever the nightly run had not yet produced h1 rows, and returned null: a
 * card with three visible model numbers and no headline above them. That is
 * what the site showed on its first morning live.
 *
 * Each entry already carries the MAE for its own horizon, so comparing them is
 * still like-for-like.
 */
export function pickHeadlineModel(models: readonly ModelPrediction[]): ModelPrediction | null {
  if (models.length === 0) return null;

  const ranked = models.filter((m) => m.mae !== null && m.n >= MIN_SCORED_DAYS_FOR_RANKING);
  if (ranked.length > 0) {
    return ranked.reduce((best, m) => (m.mae! < best.mae! ? m : best));
  }

  for (const name of MODEL_FALLBACK_ORDER) {
    const found = models.find((m) => m.model === name);
    if (found) return found;
  }
  return null;
}

/** True when no model has >= MIN_SCORED_DAYS_FOR_RANKING scored days behind it. */
export function isCalibrating(models: readonly ModelPrediction[]): boolean {
  return !models.some((m) => m.n >= MIN_SCORED_DAYS_FOR_RANKING);
}
