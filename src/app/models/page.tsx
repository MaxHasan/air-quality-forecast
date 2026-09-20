import type { Metadata } from 'next';
import { getModelAccuracy } from '@/lib/data';
import { MIN_SCORED_DAYS_FOR_RANKING, ROLLING_MEAN_WINDOW_DAYS } from '@/lib/stations';
import { AccuracyTable } from '@/components/AccuracyTable';

export const revalidate = 1800;

export const metadata: Metadata = {
  title: 'Model accuracy',
};

export default async function ModelsPage() {
  const rows = await getModelAccuracy();

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-8 sm:px-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-bold sm:text-3xl">Model accuracy</h1>
        <p className="max-w-2xl text-sm text-muted">
          Four predictors run side by side for every location, and this page tracks which one is actually right: a
          fitted wind-speed regression, Open-Meteo&apos;s CAMS atmospheric forecast, a naive persistence baseline
          (&quot;tomorrow looks like yesterday&quot;), and a rolling {ROLLING_MEAN_WINDOW_DAYS}-day average. Mean
          absolute error (MAE) over the trailing 30 scored days decides the champion per location and horizon — the
          model this app leans on for the headline call.
        </p>
        <p className="max-w-2xl text-xs text-muted">
          A location needs at least {MIN_SCORED_DAYS_FOR_RANKING} scored days before any model is trusted to lead;
          until then its cell says so honestly instead of showing a number that doesn&apos;t mean anything yet. The
          rolling average is new, so every location shows it as calibrating for its first{' '}
          {MIN_SCORED_DAYS_FOR_RANKING} days.
        </p>
        <p className="max-w-2xl text-xs text-muted">
          Both naive models are built from <em>complete</em> days only — the day in progress is never used, even
          though the evening run has already seen most of it. Before September 2026 it was, which quietly flattered
          the persistence baseline and fed the wind model a number it had not been fitted on.
        </p>
      </header>

      <AccuracyTable rows={rows} />
    </main>
  );
}
