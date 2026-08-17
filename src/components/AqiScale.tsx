import { AQI_CATEGORIES, EPA_PM25_BREAKPOINTS_PRE_2024, type AqiCategoryKey } from '@/lib/aqi';
import { ACTIVITY_THRESHOLDS, VERDICT_PRESENTATION } from '@/lib/thresholds';

/**
 * The AQI/PM2.5 scale and the activity guide, for the /about page.
 *
 * Everything here is *derived* from `src/lib/aqi.ts` and `src/lib/thresholds.ts`
 * rather than typed out again: the ranges shown to the reader are, by
 * construction, the same ones the app converts and judges with. A hand-copied
 * table would drift the first time a threshold moved.
 *
 * The scale uses the pre-2024 EPA breakpoints deliberately — that is the table
 * WAQI publishes against (verified empirically; see aqi.ts), and it is also the
 * one Nafas and most air-quality apps in the region display, so the numbers
 * here agree with what the reader sees elsewhere.
 */

const CATEGORY_FACE: Readonly<Record<AqiCategoryKey, string>> = {
  good: '😊',
  moderate: '🙂',
  unhealthy_sensitive: '😐',
  unhealthy: '😷',
  very_unhealthy: '🤢',
  hazardous: '☠️',
};

/**
 * Health implications in our own words, anchored to the EPA's public-domain
 * category descriptors (not copied from any third-party app).
 */
const CATEGORY_HEALTH: Readonly<Record<AqiCategoryKey, string>> = {
  good: 'Air is clean. No restrictions — enjoy being outside.',
  moderate:
    'Fine for most people, but unusually sensitive individuals — infants included — may notice mild respiratory irritation during long or hard activity.',
  unhealthy_sensitive:
    'Infants, older adults, and people with heart or lung conditions may feel effects; everyone else is less likely to. Shorten hard outdoor exertion.',
  unhealthy:
    'Anyone may start to feel effects — irritation, coughing, reduced lung capacity — and sensitive groups more seriously. Keep outdoor efforts short and easy.',
  very_unhealthy: 'Health alert: the risk is increased for everyone. Move activity indoors.',
  hazardous: 'Emergency conditions. Everyone should avoid outdoor activity entirely.',
};

/** PM2.5 concentration span for a category, joined across its breakpoint bands. */
function pm25RangeLabel(key: AqiCategoryKey): string {
  const bands = EPA_PM25_BREAKPOINTS_PRE_2024.breakpoints.filter((b) => b.category === key);
  if (bands.length === 0) return '—';
  const low = Math.min(...bands.map((b) => b.cLow));
  const high = Math.max(...bands.map((b) => b.cHigh));
  // The top of the scale is open-ended in practice; "250.5+" reads better than
  // pretending 500.4 is a ceiling anyone plans a picnic around.
  return key === 'hazardous' ? `${low}+` : `${low}–${high}`;
}

export function AqiScaleTable() {
  return (
    <div className="flex flex-col gap-2">
      {AQI_CATEGORIES.map((cat) => (
        <div
          key={cat.key}
          className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-1 rounded-xl border border-surface-border bg-surface p-3 sm:grid-cols-[auto_11rem_9rem_minmax(0,1fr)] sm:items-center"
        >
          <span
            aria-hidden
            className="flex h-9 w-9 items-center justify-center rounded-full text-lg"
            style={{ backgroundColor: cat.color }}
          >
            {CATEGORY_FACE[cat.key]}
          </span>
          <div className="flex flex-col leading-tight">
            <span className="text-sm font-semibold">{cat.label}</span>
            <span className="text-xs text-muted">
              AQI {cat.aqiLow}–{cat.aqiHigh}
            </span>
          </div>
          <div className="col-start-2 text-xs text-muted sm:col-start-3 sm:text-sm">
            {pm25RangeLabel(cat.key)} µg/m³
          </div>
          <p className="col-start-2 text-xs leading-relaxed text-muted sm:col-start-4">
            {CATEGORY_HEALTH[cat.key]}
          </p>
        </div>
      ))}
      <p className="text-xs text-muted">
        Ranges follow the pre-2024 US-EPA breakpoints — the scale WAQI (and most air-quality apps in the region,
        Nafas included) still publishes against. This app stores concentrations in µg/m³ and converts with exactly
        this table, so the numbers here always agree with the cards.
      </p>
    </div>
  );
}

const VERDICT_TONE_CLASSES = {
  go: 'bg-positive-bg text-positive border-positive-border',
  caution: 'bg-warning-bg text-warning border-warning-border',
  avoid: 'bg-negative-bg text-negative border-negative-border',
} as const;

export function ActivityGuide() {
  return (
    <div className="flex flex-col gap-3">
      {ACTIVITY_THRESHOLDS.map((t) => (
        <div key={t.key} className="flex flex-col gap-2 rounded-xl border border-surface-border bg-surface p-4">
          <div className="flex items-center gap-2">
            <span aria-hidden className="text-lg">
              {t.icon}
            </span>
            <span className="font-semibold">{t.label}</span>
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            <span className={`rounded-md border px-2 py-1 ${VERDICT_TONE_CLASSES.go}`}>
              {VERDICT_PRESENTATION.go.label}: ≤ {t.goMax} µg/m³
            </span>
            <span className={`rounded-md border px-2 py-1 ${VERDICT_TONE_CLASSES.caution}`}>
              {VERDICT_PRESENTATION.caution.label}: {t.goMax}–{t.cautionMax} µg/m³
            </span>
            <span className={`rounded-md border px-2 py-1 ${VERDICT_TONE_CLASSES.avoid}`}>
              {VERDICT_PRESENTATION.avoid.label}: &gt; {t.cautionMax} µg/m³
            </span>
          </div>
          <p className="text-xs leading-relaxed text-muted">{t.rationale}</p>
        </div>
      ))}
    </div>
  );
}
