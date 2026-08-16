'use client';

import { useMemo, useState } from 'react';
import type { LocationForecast } from '@/lib/types';
import { ACTIVITY_THRESHOLDS } from '@/lib/thresholds';
import { LocationCard } from './LocationCard';
import { usePreferences } from './PreferencesProvider';

interface LocationCardsClientProps {
  forecasts: LocationForecast[];
}

/** Home page card grid: reads localStorage-backed order + activity visibility
 * from `PreferencesProvider` and exposes a small settings panel to change them. */
export function LocationCardsClient({ forecasts }: LocationCardsClientProps) {
  const { cardOrder, visibleActivities, moveCard, toggleActivity, resetPreferences } = usePreferences();
  const [settingsOpen, setSettingsOpen] = useState(false);

  const byLine = useMemo(() => new Map(forecasts.map((f) => [f.location.slug, f])), [forecasts]);
  const ordered = cardOrder.map((slug) => byLine.get(slug)).filter((f): f is LocationForecast => f !== undefined);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setSettingsOpen((v) => !v)}
          className="rounded-full border border-surface-border bg-surface px-3 py-1.5 text-xs font-medium text-muted transition hover:border-accent hover:text-accent"
          aria-expanded={settingsOpen}
        >
          {settingsOpen ? 'Done' : 'Customize'}
        </button>
      </div>

      {settingsOpen && (
        <div className="flex flex-col gap-4 rounded-xl border border-surface-border bg-surface-muted p-4 text-sm">
          <div>
            <p className="mb-2 font-medium">Activities shown on each card</p>
            <div className="flex flex-wrap gap-3">
              {ACTIVITY_THRESHOLDS.map((t) => (
                <label key={t.key} className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={visibleActivities.includes(t.key)}
                    onChange={() => toggleActivity(t.key)}
                    className="h-4 w-4 accent-[var(--accent)]"
                  />
                  <span aria-hidden>{t.icon}</span>
                  {t.shortLabel}
                </label>
              ))}
            </div>
          </div>

          <div>
            <p className="mb-2 font-medium">Card order</p>
            <ol className="flex flex-col gap-1">
              {ordered.map((f, i) => (
                <li key={f.location.slug} className="flex items-center justify-between gap-2 rounded-lg bg-surface px-3 py-1.5">
                  <span>{f.location.name}</span>
                  <span className="flex gap-1">
                    <button
                      type="button"
                      disabled={i === 0}
                      onClick={() => moveCard(f.location.slug, -1)}
                      aria-label={`Move ${f.location.name} up`}
                      className="rounded px-1.5 py-0.5 text-muted enabled:hover:bg-surface-muted enabled:hover:text-foreground disabled:opacity-30"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      disabled={i === ordered.length - 1}
                      onClick={() => moveCard(f.location.slug, 1)}
                      aria-label={`Move ${f.location.name} down`}
                      className="rounded px-1.5 py-0.5 text-muted enabled:hover:bg-surface-muted enabled:hover:text-foreground disabled:opacity-30"
                    >
                      ↓
                    </button>
                  </span>
                </li>
              ))}
            </ol>
          </div>

          <button type="button" onClick={resetPreferences} className="self-start text-xs text-muted underline hover:text-accent">
            Reset to defaults
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {ordered.map((f) => (
          <LocationCard key={f.location.slug} forecast={f} visibleActivities={visibleActivities} />
        ))}
      </div>
    </div>
  );
}
