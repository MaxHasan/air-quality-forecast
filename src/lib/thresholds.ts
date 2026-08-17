/**
 * thresholds.ts — activity verdicts.
 *
 * Configuration, not logic: the numbers live in one table so they can be argued
 * with, tuned, and cited. Everything downstream reads `verdictFor`.
 *
 * All bounds are **daily-average PM2.5 in µg/m³** and are compared against the
 * same quantity the models predict.
 *
 * Where the numbers come from
 * ---------------------------
 * - WHO 2021 Global Air Quality Guidelines put the 24-hour PM2.5 guideline at
 *   **15 µg/m³**, and WHO Interim Target 4 at 25.
 * - US EPA's 2024 AQI revision breaks at **9.0** (Good), **35.4** (Moderate) and
 *   **55.4** (Unhealthy for Sensitive Groups).
 *
 * Three tiers rather than one, because the exposure differs:
 *
 * - **Newborn walk** is the strictest and is pinned to the WHO guideline. Infants
 *   breathe several times more air per kilogram of body weight than adults, their
 *   lungs are still developing, and a stroller sits low — closer to exhaust height.
 * - **Running** is stricter than general outdoor activity: hard exercise raises
 *   minute ventilation roughly ten-fold and shifts breathing from nose to mouth,
 *   bypassing nasal filtration. An hour's run at 30 µg/m³ delivers a larger dose
 *   than a whole day indoors at the same concentration.
 * - **Swimming** tracks the general-population EPA breakpoints. Outdoor pool
 *   exposure is real but ventilation is lower than running, and much of the time
 *   is spent with the face at or below water level.
 *
 * These are planning heuristics for one household, not medical advice, and the
 * /about page says so.
 */

import type { ActivityKey, Verdict } from './types';

export interface ActivityThreshold {
  key: ActivityKey;
  /** UI label. */
  label: string;
  /** Short imperative used on the card. */
  shortLabel: string;
  /** Emoji marker for the badge. */
  icon: string;
  /** `pm25 <= goMax` → 'go'. */
  goMax: number;
  /** `pm25 <= cautionMax` → 'caution'; above → 'avoid'. */
  cautionMax: number;
  /** Why these numbers — surfaced as a tooltip on the location page. */
  rationale: string;
}

/** Ordered strictest-first, which is also the order the cards render in. */
export const ACTIVITY_THRESHOLDS: readonly ActivityThreshold[] = [
  {
    key: 'newborn_walk',
    label: 'Walking the newborn',
    // "Stroller", not "pram" — the owner is American and this is his app.
    shortLabel: 'Stroller walk',
    icon: '👶',
    goMax: 15,
    cautionMax: 25,
    rationale:
      'Pinned to the WHO 2021 24-hour guideline (15 µg/m³), with the caution band ending at WHO Interim Target 4 (25). Infants inhale more air per kg of body weight than adults, their lungs are still developing, and a stroller rides low — nearer exhaust height than an adult’s airway.',
  },
  {
    key: 'running',
    label: 'Running',
    shortLabel: 'Run',
    icon: '🏃',
    goMax: 25,
    cautionMax: 35.4,
    rationale:
      'Stricter than general activity because hard exercise raises minute ventilation roughly ten-fold and shifts breathing from nose to mouth, bypassing nasal filtration. The caution band ends at the EPA "Moderate" ceiling (35.4 µg/m³).',
  },
  {
    key: 'swimming',
    label: 'Swimming / general outdoors',
    shortLabel: 'Swim',
    icon: '🏊',
    goMax: 35.4,
    cautionMax: 55.4,
    rationale:
      'Tracks the general-population EPA breakpoints: "Good/Moderate" up to 35.4 µg/m³, "Unhealthy for Sensitive Groups" up to 55.4. Ventilation is lower than running and much of the time the face is at or below water level.',
  },
] as const;

/** Index for O(1) lookup by key. */
const BY_KEY: Readonly<Record<ActivityKey, ActivityThreshold>> = Object.freeze(
  Object.fromEntries(ACTIVITY_THRESHOLDS.map((t) => [t.key, t])) as Record<ActivityKey, ActivityThreshold>,
);

/** Threshold config for one activity. */
export function thresholdFor(activity: ActivityKey): ActivityThreshold {
  return BY_KEY[activity];
}

/**
 * Traffic-light verdict for a predicted or observed daily-average PM2.5.
 *
 * Returns `null` for missing/invalid input so callers render "no data" rather
 * than defaulting to a reassuring green — the failure mode that would matter
 * here is telling someone the air is fine when we simply do not know.
 *
 * Bounds are inclusive: exactly 15 µg/m³ is still 'go' for a stroller walk.
 */
export function verdictFor(activity: ActivityKey, pm25: number | null | undefined): Verdict | null {
  if (pm25 === null || pm25 === undefined || !Number.isFinite(pm25) || pm25 < 0) return null;
  const t = BY_KEY[activity];
  if (pm25 <= t.goMax) return 'go';
  if (pm25 <= t.cautionMax) return 'caution';
  return 'avoid';
}

/** All three verdicts at one concentration — what a location card renders. */
export function allVerdicts(pm25: number | null | undefined): { activity: ActivityKey; verdict: Verdict | null }[] {
  return ACTIVITY_THRESHOLDS.map((t) => ({ activity: t.key, verdict: verdictFor(t.key, pm25) }));
}

/** Presentation metadata per verdict. Colours are theme tokens, set in globals.css. */
export const VERDICT_PRESENTATION: Readonly<
  Record<Verdict, { label: string; summary: string; tone: 'positive' | 'warning' | 'negative' }>
> = {
  go: { label: 'Go', summary: 'Good to go', tone: 'positive' },
  caution: { label: 'Caution', summary: 'Shorten it or pick a cleaner hour', tone: 'warning' },
  avoid: { label: 'Avoid', summary: 'Better indoors today', tone: 'negative' },
} as const;
