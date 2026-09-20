import Link from 'next/link';
import type { ActivityKey, LocationForecast } from '@/lib/types';
import { ACTIVITY_THRESHOLDS } from '@/lib/thresholds';
import { activityVerdictsFor } from '@/lib/verdicts';
import { AqiPill } from './AqiPill';
import { VerdictBadge, VerdictBadgeAll, VerdictBadgeUnknown } from './VerdictBadge';
import { TREND_PRESENTATION, formatLongDateLabel, formatPm25, pm25Trend } from '@/lib/display';

interface LocationCardProps {
  forecast: LocationForecast;
  visibleActivities?: readonly ActivityKey[];
}

export function LocationCard({ forecast, visibleActivities }: LocationCardProps) {
  const { location, headline, target_date, calibrating, latest_actual, today_prediction } = forecast;
  const verdicts = activityVerdictsFor(headline?.predicted_pm25 ?? null);
  const shown = visibleActivities ?? ACTIVITY_THRESHOLDS.map((t) => t.key);
  const shownThresholds = ACTIVITY_THRESHOLDS.filter((t) => shown.includes(t.key));
  const shownVerdicts = shownThresholds.map((t) => verdicts?.find((v) => v.activity === t.key) ?? null);

  // When every activity on show lands on the same verdict — the common case on
  // a genuinely bad or genuinely clear day — the three rows repeat one fact and
  // the card turns into a block of one colour. Collapse them into a single
  // badge instead. The `?.` comparison also folds the all-unknown case, where
  // every entry is null: `activityVerdictsFor` returns all verdicts or none, so
  // there is no partial state to mishandle.
  const sharedVerdict = shownVerdicts[0]?.verdict ?? null;
  const collapse = shownThresholds.length > 1 && shownVerdicts.every((v) => (v?.verdict ?? null) === sharedVerdict);

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
      className="group @container flex flex-col gap-4 rounded-2xl border border-surface-border bg-surface p-4 shadow-sm transition hover:border-accent hover:shadow-md sm:p-5"
    >
      <div>
        <h2 className="text-lg font-semibold">{location.name}</h2>
        <p className="text-sm text-muted">
          {/* The date carries the whole promise of the card — this is tomorrow,
              decided tonight — so it is spelled out and set above the caption
              around it rather than reading as small print. */}
          Forecast for{' '}
          <span className="font-semibold text-foreground">{formatLongDateLabel(target_date)}</span>
          {calibrating && (
            <span className="ml-1.5 inline-flex items-center rounded-full bg-surface-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted">
              Calibrating
            </span>
          )}
        </p>
      </div>

      {calibrating && (
        <p className="rounded-lg bg-surface-muted px-3 py-2 text-xs text-muted">
          Still calibrating here — no wind model fitted yet, so this call blends CAMS forecast and today&apos;s
          persistence only.
        </p>
      )}

      {/* The verdicts are the card's reason to exist: is tomorrow safe for the
          run, the swim, and the stroller walk? Everything else is reference
          material underneath. Full-size badges, one column on narrow screens
          so each stays legible, three across once there's room.
          A container query, not a viewport breakpoint: the card grid above
          this one goes to two and then three columns as the page widens, so
          the card itself can end up *narrower* on a wide screen than on a
          medium one, and a viewport-based `sm:` would cram three long labels
          into a slim column right when the outer grid picks three-up. */}
      {collapse ? (
        <VerdictBadgeAll
          icons={shownThresholds.map((t) => t.icon)}
          label={
            shownThresholds.length === ACTIVITY_THRESHOLDS.length
              ? 'All three activities'
              : shownThresholds.map((t) => t.shortLabel).join(' & ')
          }
          verdict={sharedVerdict}
        />
      ) : (
        <div className="grid grid-cols-1 gap-2 @sm:grid-cols-3">
          {shownThresholds.map((t, i) => {
            const v = shownVerdicts[i];
            return v ? (
              <VerdictBadge key={t.key} verdict={v} />
            ) : (
              <VerdictBadgeUnknown key={t.key} activityLabel={t.shortLabel} icon={t.icon} />
            );
          })}
        </div>
      )}

      {/* One light reference line: tomorrow's EPA category and today's level
          with its trend glyph. The current AQI is context now, not the
          headline — the verdicts above already answered the question. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
        <AqiPill pm25={headline?.predicted_pm25 ?? null} />
        {!headline && <span>No forecast yet</span>}
        <span className="flex items-center gap-1">
          Today:
          {todayValue !== null ? (
            <span className="font-medium tabular-nums text-foreground">{formatPm25(todayValue)} µg/m³</span>
          ) : (
            <span>no reading</span>
          )}
          {trendView && (
            <span
              className={`font-semibold ${trendView.toneClass}`}
              role="img"
              aria-label={`Trend: ${trendView.label}`}
              title={`Tomorrow vs today: ${trendView.label}`}
            >
              {trendView.glyph}
            </span>
          )}
        </span>
      </div>

      {/* This line only appears when there is nothing measured to show above. */}
      {!latest_actual && (
        <p className="text-[11px] text-muted">No ground-truth reading today — station feed is behind.</p>
      )}
    </Link>
  );
}
