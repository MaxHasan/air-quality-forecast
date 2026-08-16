import type { ReactNode } from 'react';

interface ChartScrollContainerProps {
  /** Minimum content width in px before the container scrolls instead of the page. */
  minWidth: number;
  height: number;
  children: ReactNode;
}

/**
 * Wraps a chart so it scrolls horizontally inside its own box on narrow
 * screens, rather than widening the page. `min-width` on the inner element
 * combined with `width: 100%` means CSS picks whichever is larger: on a wide
 * viewport the chart fills the available column; on a phone it holds its
 * minimum readable width and `.chart-scroll` (defined in globals.css) takes
 * over the horizontal scrolling.
 */
export function ChartScrollContainer({ minWidth, height, children }: ChartScrollContainerProps) {
  return (
    <div className="chart-scroll rounded-xl border border-surface-border bg-surface p-3 sm:p-4">
      <div style={{ minWidth, width: '100%', height }}>{children}</div>
    </div>
  );
}
