/**
 * display.ts — frontend-only presentation formatting.
 *
 * Deliberately separate from `src/lib/format.ts`, which is frozen and owns
 * timezone-bucketing math (the thing daily rollups and prediction targets
 * depend on). Everything here is purely cosmetic: it turns already-correct
 * values into strings for the UI and must never be trusted for bucketing or
 * scoring.
 */

import type { HorizonDays, LocalDate, ModelName } from './types';

/** `YYYY-MM-DD` → e.g. `Mon, Aug 17`. Calendar-only: never applies a timezone
 * offset, because a `LocalDate` is already the calendar date for its location. */
export function formatLocalDateLabel(localDate: LocalDate, opts: { withYear?: boolean } = {}): string {
  const [y, m, d] = localDate.split('-').map(Number);
  if (!y || !m || !d) return localDate;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: opts.withYear ? 'numeric' : undefined,
  }).format(dt);
}

/** Short weekday + day, for tight chart axes, e.g. `Mon 17`. */
export function formatShortDateLabel(localDate: LocalDate): string {
  const [y, m, d] = localDate.split('-').map(Number);
  if (!y || !m || !d) return localDate;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', day: 'numeric' }).format(dt);
}

/** One whole-number µg/m³ reading with its unit. */
export function formatPm25(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${Math.round(value)}`;
}

/** MAE/RMSE to one decimal — these are already small numbers, no rounding drama. */
export function formatMetric(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toFixed(1);
}

/** Display name for a model, used everywhere a `ModelName` needs a label. */
export const MODEL_LABELS: Readonly<Record<ModelName, string>> = {
  wind_regression: 'Wind model',
  cams: 'CAMS forecast',
  persistence: 'Persistence',
} as const;

/** One-line description of what a model does, for tooltips and the /about page. */
export const MODEL_DESCRIPTIONS: Readonly<Record<ModelName, string>> = {
  wind_regression: "Massimiliano's wind-speed regression, fitted per region on observed PM2.5 and wind.",
  cams: "Open-Meteo's CAMS atmospheric forecast, a 40 km-grid global model.",
  persistence: "Tomorrow looks like today — today's running average carried forward.",
} as const;

/** Short model abbreviation for tight spaces (model strips, table headers). */
export const MODEL_SHORT_LABELS: Readonly<Record<ModelName, string>> = {
  wind_regression: 'Wind',
  cams: 'CAMS',
  persistence: 'Persist.',
} as const;

export function formatHorizon(horizon: HorizonDays): string {
  return horizon === 1 ? 'Tomorrow' : `${horizon} days out`;
}

/** e.g. `2` -> "2 more scored days" for the /models empty state. */
export function scoredDaysRemaining(n: number, minRequired: number): number {
  return Math.max(0, minRequired - n);
}
