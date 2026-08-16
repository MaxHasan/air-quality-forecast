import { ACTIVITY_THRESHOLDS } from '@/lib/thresholds';
import { activityVerdictsFor } from '@/lib/verdicts';
import { VerdictBadge, VerdictBadgeUnknown } from './VerdictBadge';

interface VerdictPanelProps {
  pm25: number | null;
}

/** Full verdict cards for the location detail page, each carrying its threshold's rationale. */
export function VerdictPanel({ pm25 }: VerdictPanelProps) {
  const verdicts = activityVerdictsFor(pm25);

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      {ACTIVITY_THRESHOLDS.map((t) => {
        const v = verdicts?.find((x) => x.activity === t.key) ?? null;
        return (
          <div key={t.key} className="flex flex-col gap-2 rounded-xl border border-surface-border bg-surface p-4">
            {v ? <VerdictBadge verdict={v} /> : <VerdictBadgeUnknown activityLabel={t.label} icon={t.icon} />}
            <p className="text-xs leading-relaxed text-muted">{t.rationale}</p>
            <p className="text-[11px] text-muted">
              Go ≤ {t.goMax} · Caution ≤ {t.cautionMax} · Avoid &gt; {t.cautionMax} µg/m³
            </p>
          </div>
        );
      })}
    </div>
  );
}
