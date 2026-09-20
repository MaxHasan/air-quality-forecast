import {
  MODEL_FALLBACK_ORDER,
  type HorizonDays,
  type LocalDate,
  type LocationSlug,
  type ModelAccuracyRow,
  type ModelName,
} from '@/lib/types';
import { LOCATIONS, MIN_SCORED_DAYS_FOR_RANKING, STALE_SCORE_DAYS } from '@/lib/stations';
import {
  MODEL_LABELS,
  daysSinceLocalDate,
  formatHorizon,
  formatLocalDateLabel,
  formatMetric,
  scoredDaysRemaining,
} from '@/lib/display';

/**
 * NOT compiler-enforced — a plain array, not a `Record<ModelName, …>`.
 *
 * Omit a model here and its column simply vanishes from /models with no type
 * error and no test failure. Derived from MODEL_FALLBACK_ORDER so a fifth
 * model cannot be forgotten the way a fourth nearly was; that constant is also
 * the render order everywhere else, which is the order this table wants.
 */
const MODEL_COLUMNS: readonly ModelName[] = MODEL_FALLBACK_ORDER;
const HORIZONS: readonly HorizonDays[] = [1, 2, 3];

interface AccuracyTableProps {
  rows: ModelAccuracyRow[];
}

/** The accuracy board: location x model x horizon MAE, with the champion model per
 * location/horizon marked, and an honest "needs 7 scored days" state where data is thin. */
export function AccuracyTable({ rows }: AccuracyTableProps) {
  const bySlug = new Map<LocationSlug, ModelAccuracyRow[]>();
  for (const r of rows) {
    const list = bySlug.get(r.location_slug) ?? [];
    list.push(r);
    bySlug.set(r.location_slug, list);
  }

  return (
    <div className="flex flex-col gap-6">
      {LOCATIONS.map((loc) => {
        const locRows = bySlug.get(loc.slug) ?? [];
        // How old is the freshest thing being reported here?
        //
        // `model_accuracy` is a rolling 30-day window, so a location whose feed
        // died three weeks ago still publishes numbers — computed from the days
        // before it died, and presented with nothing to say so. jakarta-north
        // read "persistence 1.83" for weeks after its last observation; that
        // figure was real and correctly computed, and it described August.
        //
        // Deliberately NOT suppressed. Hiding a measurement because it is old
        // throws away the only evidence there is; dating it lets the reader
        // decide. The bar for "stale" is the same one the ingestion footer
        // uses, in days rather than hours.
        const lastScored = locRows.reduce<LocalDate | null>(
          (newest, r) => (newest === null || r.last_scored_date > newest ? r.last_scored_date : newest),
          null,
        );
        const staleDays = lastScored ? daysSinceLocalDate(lastScored, loc.timezone) : null;
        const isStale = staleDays !== null && staleDays > STALE_SCORE_DAYS;

        return (
          <section key={loc.slug} className="rounded-xl border border-surface-border bg-surface p-4 sm:p-5">
            <h3 className="mb-3 text-base font-semibold">{loc.name}</h3>
            {isStale && lastScored && (
              <p className="mb-3 rounded-lg border border-warning-border bg-warning-bg px-3 py-2 text-xs text-warning">
                <span aria-hidden>▲ </span>
                Last scored {formatLocalDateLabel(lastScored)}, {staleDays} days ago. These figures describe that
                period, not today — the ground-truth feed has been quiet since.
              </p>
            )}
            {locRows.length === 0 ? (
              <p className="rounded-lg bg-surface-muted px-3 py-3 text-sm text-muted">
                No scored predictions yet — check the footer for ingestion status; scoring resumes once a full day of
                ground truth lands.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[480px] border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-surface-border text-left text-xs uppercase tracking-wide text-muted">
                      <th className="py-2 pr-3 font-medium">Horizon</th>
                      {MODEL_COLUMNS.map((m) => (
                        <th key={m} className="py-2 pr-3 font-medium">
                          {MODEL_LABELS[m]}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {HORIZONS.map((h) => {
                      const cells = MODEL_COLUMNS.map((m) => locRows.find((r) => r.model === m && r.horizon_days === h) ?? null);
                      const champion = cells
                        .filter((c): c is ModelAccuracyRow => c !== null && c.n >= MIN_SCORED_DAYS_FOR_RANKING)
                        .reduce<ModelAccuracyRow | null>((best, c) => (best === null || c.mae < best.mae ? c : best), null);

                      return (
                        <tr key={h} className="border-b border-surface-border last:border-0">
                          <td className="py-2.5 pr-3 font-medium">{formatHorizon(h)}</td>
                          {cells.map((c, i) => (
                            <td key={MODEL_COLUMNS[i]} className="py-2.5 pr-3 align-top">
                              <AccuracyCell row={c} isChampion={c !== null && champion !== null && c === champion} />
                            </td>
                          ))}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function AccuracyCell({ row, isChampion }: { row: ModelAccuracyRow | null; isChampion: boolean }) {
  if (!row) {
    return <span className="text-xs italic text-muted">Not available yet</span>;
  }

  if (row.n < MIN_SCORED_DAYS_FOR_RANKING) {
    const remaining = scoredDaysRemaining(row.n, MIN_SCORED_DAYS_FOR_RANKING);
    return (
      <span className="text-xs italic text-muted">
        Calibrating — n={row.n}, needs {remaining} more scored day{remaining === 1 ? '' : 's'}
      </span>
    );
  }

  return (
    <div className="flex flex-col gap-0.5">
      <span className="flex items-center gap-1.5 font-semibold tabular-nums">
        {formatMetric(row.mae)} µg/m³
        {isChampion && (
          <span className="inline-flex items-center gap-0.5 rounded-full bg-positive-bg px-1.5 py-0.5 text-[10px] font-semibold text-positive">
            ★ Champion
          </span>
        )}
      </span>
      <span className="text-[11px] text-muted">
        RMSE {formatMetric(row.rmse)} · bias {row.bias > 0 ? '+' : ''}
        {formatMetric(row.bias)} · n={row.n}
      </span>
    </div>
  );
}
