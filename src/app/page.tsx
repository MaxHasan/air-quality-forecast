import type { Metadata } from 'next';
import { getLocationForecasts } from '@/lib/data';
import { LocationCardsClient } from '@/components/LocationCardsClient';

export const revalidate = 1800;

export const metadata: Metadata = {
  title: 'Forecasts',
};

export default async function HomePage() {
  const forecasts = await getLocationForecasts();

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-8 sm:px-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-bold sm:text-3xl">Air Quality Predictor</h1>
        <p className="max-w-2xl text-sm text-muted">
          Tomorrow&apos;s PM2.5 for Jabodetabek, Bali and Singapore, with a verdict for the run, the swim, and the
          pram walk — built so you can decide tonight, not scramble in the morning.
        </p>
      </header>

      <LocationCardsClient forecasts={forecasts} />
    </main>
  );
}
