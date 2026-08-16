import { pm25Category } from '@/lib/aqi';
import { formatPm25 } from '@/lib/display';

interface AqiPillProps {
  pm25: number | null;
  size?: 'sm' | 'lg';
}

/**
 * The EPA category chip for a PM2.5 reading, using the official breakpoint
 * colours from `AQI_CATEGORIES` directly (not a theme token — these colours
 * are a recognised standard and should not shift with light/dark mode).
 */
export function AqiPill({ pm25, size = 'sm' }: AqiPillProps) {
  const category = pm25 !== null ? pm25Category(pm25) : null;

  if (!category || pm25 === null) {
    return (
      <span className="inline-flex items-center rounded-full border border-dashed border-surface-border px-3 py-1 text-sm text-muted">
        No data
      </span>
    );
  }

  const padding = size === 'lg' ? 'px-3.5 py-1.5 text-sm' : 'px-2.5 py-1 text-xs';

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full font-semibold ${padding}`}
      style={{ backgroundColor: category.color, color: category.onColor }}
    >
      {category.label}
      <span className="font-normal opacity-90">· {formatPm25(pm25)} µg/m³</span>
    </span>
  );
}
