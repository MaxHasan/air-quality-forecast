import Link from 'next/link';
import type { ActivityKey, LocationForecast } from '@/lib/types';
import { ACTIVITY_THRESHOLDS } from '@/lib/thresholds';
import { activityVerdictsFor } from '@/lib/verdicts';
import { AqiPill } from './AqiPill';
import { ModelStrip } from './ModelStrip';
import { VerdictBadge, VerdictBadgeUnknown } from './VerdictBadge';
import { TREND_PRESENTATION, formatLocalDateLabel, formatPm25, pm25Trend } from '@/lib/display';

interface LocationCardProps {
  forecast: LocationForecast;
  visibleActivities?: readonly ActivityKey[];
}

export function LocationCard({ forecast, visibleActivities }: LocationCardProps) {
  const { location, headline, models, target_date, calibrating, latest_actual, today_prediction } = forecast;
  const verdicts = activityVerdictsFor(headline?.predicted_pm25 ?? null);
  const shown = visibleActivities ?? ACTIVITY_THRESHOLDS.map((t) => t.key);

  // Today's reference level: the observed rollup when the stations have
  // reported, else the value today was forecast at. The observed figure wins
  // because it is a measurement; the forecast stands in only when there is
  // nothing measured yet (early morning, or a feed outage).
  const todayValue = latest_actual?.pm25_avg ?? today_prediction?.predicted_pm25 ?? null;
  const trend = pm25Trend(todayValue, headline?.predicted_pm25 ?? null);
  const trendView = trend ? TREND_PRESENTATION[trend] : null;

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

      {/* Today ↔ tomorrow, side by side: level and direction in one glance.
          Tomorrow stays visually dominant — it is the decision the card exists
          for; today is the anchor that makes the number mean something. */}
      <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1.4fr)] items-end gap-3">
        <div className="flex min-w-0 flex-col">
          <span className="text-[10px] font-medium uppercase tracking-wide text-muted">Today</span>
          {todayValue !== null ? (
            <>
              <span className="text-xl font-semibold tabular-nums text-muted">
                {formatPm25(todayValue)}
                <span className="ml-1 text-xs font-normal">µg/m³</span>
              </span>
              <span className="truncate text-[11px] text-muted">
                {latest_actual
                  ? `so far · ${latest_actual.hours_count}h, ${latest_actual.station_count} station${latest_actual.station_count === 1 ? '' : 's'}`
                  : 'forecast — no reading yet'}
              </span>
              {latest_actual && today_prediction && (
                <span className="truncate text-[11px] text-muted">
                  called at {formatPm25(today_prediction.predicted_pm25)}
                </span>
              )}
            </>
          ) : (
            <span className="text-sm text-muted">no reading</span>
          )}
        </div>

        {trendView ? (
          <span
            className={`pb-1 text-lg font-semibold ${trendView.toneClass}`}
            role="img"
            aria-label={`Trend: ${trendView.label}`}
            title={`Tomorrow vs today: ${trendView.label}`}
          >
            {trendView.glyph}
          </span>
        ) : (
          <span aria-hidden className="pb-1 text-lg text-muted">
            ·
          </span>
        )}

        <div className="flex min-w-0 flex-col">
          <span className="text-[10px] font-medium uppercase tracking-wide text-muted">Tomorrow</span>
          {headline ? (
            <>
              <span className="text-4xl font-bold tabular-nums">
                {formatPm25(headline.predicted_pm25)}
                <span className="ml-1 text-sm font-normal text-muted">µg/m³</span>
              </span>
              {headline.horizon_days > 1 && (
                <span className="text-[11px] text-muted">issued {headline.horizon_days} days out</span>
              )}
            </>
          ) : (
            <span className="text-sm text-muted">No forecast yet</span>
          )}
        </div>
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

      {/* The observed-so-far detail lives in the Today column now; this line
          only appears when there is nothing measured to show there. */}
      {!latest_actual && (
        <p className="text-[11px] text-muted">No ground-truth reading today — station feed is behind.</p>
      )}
    </Link>
  );
}
