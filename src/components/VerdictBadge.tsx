import type { ActivityVerdict, Verdict } from '@/lib/types';
import { VERDICT_PRESENTATION, thresholdFor } from '@/lib/thresholds';

/**
 * Icon + text per verdict, never colour alone — red/green colour-vision
 * deficiency is the most common kind, so the tone must be legible from the
 * glyph and label without needing to distinguish hue.
 */
const VERDICT_GLYPH: Readonly<Record<Verdict, string>> = {
  go: '✓', // check mark
  caution: '▲', // triangle, evokes a warning sign
  avoid: '✕', // multiplication/cross mark
};

const TONE_CLASSES: Readonly<Record<Verdict, string>> = {
  go: 'bg-positive-bg text-positive border-positive-border',
  caution: 'bg-warning-bg text-warning border-warning-border',
  avoid: 'bg-negative-bg text-negative border-negative-border',
};

interface VerdictBadgeProps {
  verdict: ActivityVerdict;
  compact?: boolean;
}

/** One activity's traffic-light verdict, rendered as an accessible badge. */
export function VerdictBadge({ verdict, compact }: VerdictBadgeProps) {
  const presentation = VERDICT_PRESENTATION[verdict.verdict];
  const config = thresholdFor(verdict.activity);
  const toneClass = TONE_CLASSES[verdict.verdict];

  return (
    <div
      className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 ${toneClass} ${compact ? 'text-xs' : 'text-sm'}`}
      title={config.rationale}
    >
      <span aria-hidden className="text-base leading-none">
        {config.icon}
      </span>
      <span className="flex flex-col leading-tight">
        <span className="font-medium">{compact ? config.shortLabel : verdict.label}</span>
        <span className="flex items-center gap-1 font-semibold">
          <span aria-hidden>{VERDICT_GLYPH[verdict.verdict]}</span>
          {presentation.label}
        </span>
      </span>
    </div>
  );
}

/** Placeholder shown when no PM2.5 value is available to judge — never a fabricated verdict. */
export function VerdictBadgeUnknown({ activityLabel, icon, compact }: { activityLabel: string; icon: string; compact?: boolean }) {
  return (
    <div
      className={`flex items-center gap-2 rounded-lg border border-dashed border-surface-border bg-surface-muted px-2.5 py-1.5 text-muted ${compact ? 'text-xs' : 'text-sm'}`}
    >
      <span aria-hidden className="text-base leading-none opacity-60">
        {icon}
      </span>
      <span className="flex flex-col leading-tight">
        <span className="font-medium">{activityLabel}</span>
        <span>No data</span>
      </span>
    </div>
  );
}
