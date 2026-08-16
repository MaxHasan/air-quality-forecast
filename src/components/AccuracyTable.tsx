import type { HorizonDays, LocationSlug, ModelAccuracyRow, ModelName } from '@/lib/types';
import { LOCATIONS, MIN_SCORED_DAYS_FOR_RANKING } from '@/lib/stations';
import { MODEL_LABELS, formatHorizon, formatMetric, scoredDaysRemaining } from '@/lib/display';

const MODEL_COLUMNS: readonly ModelName[] = ['wind_regression', 'cams', 'persistence'];
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
        return (
          <section key={loc.slug} className="rounded-xl border border-surface-border bg-surface p-4 sm:p-5">
            <h3 className="mb-3 text-base font-semibold">{loc.name}</h3>
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
