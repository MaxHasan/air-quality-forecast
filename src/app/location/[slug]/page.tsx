import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDailyHistory, getHourlyPm25, getLocationForecast } from '@/lib/data';
import { LOCATIONS, locationBySlug } from '@/lib/stations';
import type { LocationSlug } from '@/lib/types';
import { formatLocalDateLabel, formatPm25 } from '@/lib/display';
import { AqiPill } from '@/components/AqiPill';
import { ModelStrip } from '@/components/ModelStrip';
import { VerdictPanel } from '@/components/VerdictPanel';
import { WindOverlayChart } from '@/components/WindOverlayChart';
import { DailyForecastChart } from '@/components/DailyForecastChart';

export const revalidate = 1800;

export function generateStaticParams() {
  return LOCATIONS.map((l) => ({ slug: l.slug }));
}

interface PageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const loc = locationBySlug(slug);
  return { title: loc ? loc.name : 'Location' };
}

export default async function LocationPage({ params }: PageProps) {
  const { slug } = await params;
  const loc = locationBySlug(slug);
  if (!loc) notFound();
  const typedSlug = loc.slug as LocationSlug;

  const [forecast, hourly, daily] = await Promise.all([
    getLocationForecast(typedSlug),
    getHourlyPm25(typedSlug),
    getDailyHistory(typedSlug),
  ]);

  if (!forecast) notFound();

  const headlinePm25 = forecast.headline?.predicted_pm25 ?? null;

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-8 px-4 py-8 sm:px-6">
      <div>
        <Link href="/" className="text-xs text-muted underline hover:text-accent">
          ← All locations
        </Link>
      </div>

      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold sm:text-3xl">{loc.name}</h1>
            <p className="text-sm text-muted">Forecast for {formatLocalDateLabel(forecast.target_date)}</p>
          </div>
          <AqiPill pm25={headlinePm25} size="lg" />
        </div>

        {forecast.calibrating && (
          <p className="rounded-lg border border-surface-border bg-surface-muted px-4 py-3 text-sm text-muted">
            Still calibrating: there isn&apos;t a fitted wind model here yet, so the headline call blends the CAMS
            forecast and today&apos;s persistence baseline. A wind-speed regression joins once ~90 days of ground
            truth accumulate.
          </p>
        )}

        <div className="flex items-baseline gap-3">
          {headlinePm25 !== null ? (
            <>
              <span className="text-5xl font-bold tabular-nums">{formatPm25(headlinePm25)}</span>
              <span className="text-sm text-muted">µg/m³ PM2.5, tomorrow</span>
            </>
          ) : (
            <span className="text-sm text-muted">No forecast available yet</span>
          )}
        </div>

        <ModelStrip models={forecast.models} headlineModel={forecast.headline?.model ?? null} />

        <p className="text-xs text-muted">
          {forecast.latest_actual
            ? `Today so far: ${formatPm25(forecast.latest_actual.pm25_avg)} µg/m³ over ${forecast.latest_actual.hours_count}h from ${forecast.latest_actual.station_count} station${forecast.latest_actual.station_count === 1 ? '' : 's'}.`
            : 'No recent ground-truth reading for today — the station feed is behind. See the footer for ingestion status.'}
        </p>
      </header>

      <section className="flex flex-col gap-3">
        <div>
          <h2 className="text-lg font-semibold">Last 7 days: PM2.5 and wind speed</h2>
          <p className="text-xs text-muted">
            This is the causal story the app is built on — PM2.5 tends to climb as wind speed falls.
          </p>
        </div>
        <WindOverlayChart points={hourly} />
      </section>

      <section className="flex flex-col gap-3">
        <div>
          <h2 className="text-lg font-semibold">30-day history and 3-day forecast</h2>
          <p className="text-xs text-muted">Each model&apos;s call diverges from today, dashed.</p>
        </div>
        <DailyForecastChart points={daily} />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Should you go?</h2>
        <VerdictPanel pm25={headlinePm25} />
      </section>
    </main>
  );
}
