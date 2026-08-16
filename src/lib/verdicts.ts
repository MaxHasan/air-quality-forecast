/**
 * verdicts.ts — assembles `ActivityVerdict[]` (the frontend composite defined
 * in `src/lib/types.ts`) from the frozen `thresholds.ts` primitives.
 *
 * Kept separate from `thresholds.ts` itself (frozen, owned by the pipeline
 * workstream) so the presentation shape can evolve without touching the
 * contract file.
 */

import { ACTIVITY_THRESHOLDS, verdictFor } from './thresholds';
import type { ActivityVerdict } from './types';

/**
 * All three activity verdicts for one PM2.5 value, ready to render as badges.
 *
 * Returns `null` — not a fabricated 'avoid' — when `pm25` is missing, so
 * callers render an explicit "no forecast yet" state instead of a badge that
 * looks confident but carries a NaN concentration.
 */
export function activityVerdictsFor(pm25: number | null | undefined): ActivityVerdict[] | null {
  if (pm25 === null || pm25 === undefined || !Number.isFinite(pm25)) return null;
  return ACTIVITY_THRESHOLDS.map((t) => ({
    activity: t.key,
    label: t.label,
    verdict: verdictFor(t.key, pm25)!,
    pm25,
  }));
}
