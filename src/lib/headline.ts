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

export function pickHeadlineModel(models: readonly ModelPrediction[]): ModelPrediction | null {
  const h1 = models.filter((m) => m.horizon_days === 1);
  if (h1.length === 0) return null;

  const ranked = h1.filter((m) => m.mae !== null && m.n >= MIN_SCORED_DAYS_FOR_RANKING);
  if (ranked.length > 0) {
    return ranked.reduce((best, m) => (m.mae! < best.mae! ? m : best));
  }

  for (const name of MODEL_FALLBACK_ORDER) {
    const found = h1.find((m) => m.model === name);
    if (found) return found;
  }
  return null;
}

/** True when no model has >= MIN_SCORED_DAYS_FOR_RANKING scored days at horizon 1. */
export function isCalibrating(models: readonly ModelPrediction[]): boolean {
  return !models.some((m) => m.horizon_days === 1 && m.n >= MIN_SCORED_DAYS_FOR_RANKING);
}
