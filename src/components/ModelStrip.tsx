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
          {/*
            Deliberately NOT the word "calibrating". That word is already taken
            on this screen by the card-level badge, where it means "no wind
            model has been fitted for this location". Here it would mean
            something quite different — the model exists and has produced this
            number, it simply has not been scored against a realised day yet.
            Jakarta showed both at once ("Wind 38 (calibrating)" on a card with
            no CALIBRATING badge), which reads as if the forecast cannot be
            trusted when the only missing thing is its track record.
          */}
          <span className="opacity-70">
            {m.mae !== null ? `(MAE ${formatMetric(m.mae)})` : '(unscored)'}
          </span>
        </li>
      ))}
    </ul>
  );
}
