import type { Metadata } from 'next';
import { getModelAccuracy } from '@/lib/data';
import { MIN_SCORED_DAYS_FOR_RANKING } from '@/lib/stations';
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
          Three predictors run side by side for every location, and this page tracks which one is actually right: a
          fitted wind-speed regression, Open-Meteo&apos;s CAMS atmospheric forecast, and a naive persistence
          baseline (&quot;tomorrow looks like today&quot;). Mean absolute error (MAE) over the trailing 30 scored
          days decides the champion per location and horizon — the model this app leans on for the headline call.
        </p>
        <p className="max-w-2xl text-xs text-muted">
          A location needs at least {MIN_SCORED_DAYS_FOR_RANKING} scored days before any model is trusted to lead;
          until then its cell says so honestly instead of showing a number that doesn&apos;t mean anything yet.
        </p>
      </header>

      <AccuracyTable rows={rows} />
    </main>
  );
}
