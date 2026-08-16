'use client';

/**
 * PreferencesProvider — localStorage-backed UI preferences.
 *
 * v1 has no auth (per the plan), so "settings" live entirely client-side:
 * card order on `/` and which activity badges to show. Guarded against SSR
 * (`typeof window`) and hydration mismatches: the provider always renders
 * with the default preferences on the very first client render (matching
 * what the server rendered), then loads localStorage in an effect and
 * re-renders once. A one-frame "snap" to the stored order is the trade-off
 * for never mismatching the server-rendered markup.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ActivityKey, LocationSlug } from '@/lib/types';
import { ACTIVITY_THRESHOLDS } from '@/lib/thresholds';
import { LOCATIONS } from '@/lib/stations';

const STORAGE_KEY = 'aq-predictor:prefs:v1';

export const DEFAULT_CARD_ORDER: LocationSlug[] = LOCATIONS.slice()
  .sort((a, b) => a.order - b.order)
  .map((l) => l.slug);

export const DEFAULT_VISIBLE_ACTIVITIES: ActivityKey[] = ACTIVITY_THRESHOLDS.map((t) => t.key);

interface StoredPrefs {
  cardOrder?: LocationSlug[];
  visibleActivities?: ActivityKey[];
}

interface PreferencesValue {
  cardOrder: LocationSlug[];
  visibleActivities: ActivityKey[];
  /** True once localStorage has been read — lets consumers avoid a reorder flash if they care to. */
  hydrated: boolean;
  setCardOrder: (order: LocationSlug[]) => void;
  moveCard: (slug: LocationSlug, direction: -1 | 1) => void;
  toggleActivity: (activity: ActivityKey) => void;
  resetPreferences: () => void;
}

const PreferencesContext = createContext<PreferencesValue | null>(null);

function readStoredPrefs(): StoredPrefs {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as StoredPrefs;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeStoredPrefs(prefs: StoredPrefs): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Storage full or blocked (private browsing) — preferences just won't persist.
  }
}

/** Reconcile a stored order against the current known slugs: keep valid entries in
 * their stored positions, then append any new/unknown-order locations at the end. */
function sanitizeOrder(stored: LocationSlug[] | undefined): LocationSlug[] {
  const known = new Set(DEFAULT_CARD_ORDER);
  const kept = (stored ?? []).filter((s): s is LocationSlug => known.has(s));
  const missing = DEFAULT_CARD_ORDER.filter((s) => !kept.includes(s));
  return [...kept, ...missing];
}

function sanitizeActivities(stored: ActivityKey[] | undefined): ActivityKey[] {
  if (!stored || stored.length === 0) return DEFAULT_VISIBLE_ACTIVITIES;
  const known = new Set(DEFAULT_VISIBLE_ACTIVITIES);
  const kept = stored.filter((a) => known.has(a));
  return kept.length > 0 ? kept : DEFAULT_VISIBLE_ACTIVITIES;
}

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [cardOrder, setCardOrderState] = useState<LocationSlug[]>(DEFAULT_CARD_ORDER);
  const [visibleActivities, setVisibleActivities] = useState<ActivityKey[]>(DEFAULT_VISIBLE_ACTIVITIES);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const stored = readStoredPrefs();
    setCardOrderState(sanitizeOrder(stored.cardOrder));
    setVisibleActivities(sanitizeActivities(stored.visibleActivities));
    setHydrated(true);
  }, []);

  const setCardOrder = useCallback((order: LocationSlug[]) => {
    const clean = sanitizeOrder(order);
    setCardOrderState(clean);
    writeStoredPrefs({ cardOrder: clean, visibleActivities: readStoredPrefs().visibleActivities });
  }, []);

  const moveCard = useCallback((slug: LocationSlug, direction: -1 | 1) => {
    setCardOrderState((prev) => {
      const idx = prev.indexOf(slug);
      const target = idx + direction;
      if (idx === -1 || target < 0 || target >= prev.length) return prev;
      const next = prev.slice();
      [next[idx], next[target]] = [next[target], next[idx]];
      writeStoredPrefs({ cardOrder: next, visibleActivities: readStoredPrefs().visibleActivities });
      return next;
    });
  }, []);

  const toggleActivity = useCallback((activity: ActivityKey) => {
    setVisibleActivities((prev) => {
      const isShown = prev.includes(activity);
      // Never allow hiding the last remaining badge — an empty card teaches nothing.
      if (isShown && prev.length === 1) return prev;
      const next = isShown ? prev.filter((a) => a !== activity) : [...prev, activity];
      const ordered = DEFAULT_VISIBLE_ACTIVITIES.filter((a) => next.includes(a));
      writeStoredPrefs({ cardOrder: readStoredPrefs().cardOrder, visibleActivities: ordered });
      return ordered;
    });
  }, []);

  const resetPreferences = useCallback(() => {
    setCardOrderState(DEFAULT_CARD_ORDER);
    setVisibleActivities(DEFAULT_VISIBLE_ACTIVITIES);
    writeStoredPrefs({});
  }, []);

  const value = useMemo<PreferencesValue>(
    () => ({ cardOrder, visibleActivities, hydrated, setCardOrder, moveCard, toggleActivity, resetPreferences }),
    [cardOrder, visibleActivities, hydrated, setCardOrder, moveCard, toggleActivity, resetPreferences],
  );

  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

export function usePreferences(): PreferencesValue {
  const ctx = useContext(PreferencesContext);
  if (!ctx) throw new Error('usePreferences() must be used within a PreferencesProvider');
  return ctx;
}
