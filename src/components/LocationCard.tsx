import Link from 'next/link';
import type { ActivityKey, LocationForecast } from '@/lib/types';
import { ACTIVITY_THRESHOLDS } from '@/lib/thresholds';
import { activityVerdictsFor } from '@/lib/verdicts';
import { AqiPill } from './AqiPill';
import { ModelStrip } from './ModelStrip';
import { VerdictBadge, VerdictBadgeUnknown } from './VerdictBadge';
import { formatLocalDateLabel, formatPm25 } from '@/lib/display';

interface LocationCardProps {
  forecast: LocationForecast;
  visibleActivities?: readonly ActivityKey[];
}

export function LocationCard({ forecast, visibleActivities }: LocationCardProps) {
  const { location, headline, models, target_date, calibrating, latest_actual } = forecast;
  const verdicts = activityVerdictsFor(headline?.predicted_pm25 ?? null);
  const shown = visibleActivities ?? ACTIVITY_THRESHOLDS.map((t) => t.key);

  return (
    <Link
      href={`/location/${location.slug}`}
      data-slug={location.slug}
      className="group flex flex-col gap-3 rounded-2xl border border-surface-border bg-surface p-4 shadow-sm transition hover:border-accent hover:shadow-md sm:p-5"
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">{location.name}</h2>
          <p className="text-xs text-muted">
            Forecast for {formatLocalDateLabel(target_date)}
            {calibrating && (
              <span className="ml-1.5 inline-flex items-center rounded-full bg-surface-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted">
                Calibrating
              </span>
            )}
          </p>
        </div>
        <AqiPill pm25={headline?.predicted_pm25 ?? null} />
      </div>

      <div className="flex items-baseline gap-2">
        {headline ? (
          <>
            <span className="text-4xl font-bold tabular-nums">{formatPm25(headline.predicted_pm25)}</span>
            <span className="text-sm text-muted">µg/m³ PM2.5</span>
          </>
        ) : (
          <span className="text-sm text-muted">No forecast yet</span>
        )}
      </div>

      {calibrating && (
        <p className="rounded-lg bg-surface-muted px-3 py-2 text-xs text-muted">
          Still calibrating here — no wind model fitted yet, so this call blends CAMS forecast and today&apos;s
          persistence only.
        </p>
      )}

      <ModelStrip models={models} headlineModel={headline?.model ?? null} />

      <div className="flex flex-wrap gap-2 pt-1">
        {ACTIVITY_THRESHOLDS.filter((t) => shown.includes(t.key)).map((t) => {
          const v = verdicts?.find((x) => x.activity === t.key) ?? null;
          return v ? (
            <VerdictBadge key={t.key} verdict={v} compact />
          ) : (
            <VerdictBadgeUnknown key={t.key} activityLabel={t.shortLabel} icon={t.icon} compact />
          );
        })}
      </div>

      <p className="text-[11px] text-muted">
        {latest_actual
          ? `Today so far: ${formatPm25(latest_actual.pm25_avg)} µg/m³ (${latest_actual.hours_count}h, ${latest_actual.station_count} station${latest_actual.station_count === 1 ? '' : 's'})`
          : 'No recent ground-truth reading — station feed is behind.'}
      </p>
    </Link>
  );
}
