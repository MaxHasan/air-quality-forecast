import type { ModelName, ModelPrediction } from '@/lib/types';
import { MODEL_SHORT_LABELS, formatMetric, formatPm25 } from '@/lib/display';

const MODEL_DOT: Readonly<Record<ModelName, string>> = {
  wind_regression: 'bg-[var(--chart-pm25)]',
  cams: 'bg-[var(--chart-wind)]',
  persistence: 'bg-muted',
};

interface ModelStripProps {
  models: ModelPrediction[];
  headlineModel: ModelName | null;
}

/** Compact row of every model's call, with the winning one marked — the "three models, one answer" strip. */
export function ModelStrip({ models, headlineModel }: ModelStripProps) {
  if (models.length === 0) {
    return <p className="text-xs text-muted">No model has produced a forecast yet.</p>;
  }

  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
      {models.map((m) => (
        <li key={m.model} className="flex items-center gap-1.5">
          <span aria-hidden className={`inline-block h-2 w-2 rounded-full ${MODEL_DOT[m.model]}`} />
          <span className={m.model === headlineModel ? 'font-semibold text-foreground' : ''}>
            {MODEL_SHORT_LABELS[m.model]} {formatPm25(m.predicted_pm25)}
          </span>
          <span className="opacity-70">{m.mae !== null ? `(MAE ${formatMetric(m.mae)})` : '(calibrating)'}</span>
        </li>
      ))}
    </ul>
  );
}
