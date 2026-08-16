'use client';

import { useMemo } from 'react';
import { CartesianGrid, Legend, Line, ComposedChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { DailyPoint, ModelName } from '@/lib/types';
import { MODEL_LABELS, formatShortDateLabel } from '@/lib/display';
import { ChartScrollContainer } from './ChartScrollContainer';

interface DailyForecastChartProps {
  points: DailyPoint[]; // history (actual_pm25 set) followed by the forecast fan (predicted set)
}

const MODEL_COLOR: Readonly<Record<ModelName, string>> = {
  wind_regression: 'var(--chart-pm25)',
  cams: 'var(--chart-wind)',
  persistence: 'var(--muted)',
};

const MODEL_DASH: Readonly<Record<ModelName, string>> = {
  wind_regression: '0',
  cams: '5 3',
  persistence: '2 3',
};

/**
 * 30-day daily history plus a 3-day forecast fan: every model that produced a
 * call is its own line, diverging from the last observed day.
 */
export function DailyForecastChart({ points }: DailyForecastChartProps) {
  const { data, availableModels, todayLabel } = useMemo(() => {
    const models = new Set<ModelName>();
    for (const p of points) for (const m of Object.keys(p.predicted) as ModelName[]) models.add(m);

    // The anchor is the *most recent* day carrying an observation, found from the
    // end. Scanning forward for the first gap was equivalent while history came
    // from fixtures, where every past day had a value — but live history is
    // sparse wherever a feed was down, and a gap on day 2 would anchor "Today"
    // (and the point every forecast line diverges from) on day 1 of thirty.
    let lastHistoryIdx = -1;
    for (let i = points.length - 1; i >= 0; i -= 1) {
      if (points[i].actual_pm25 !== null) {
        lastHistoryIdx = i;
        break;
      }
    }
    const anchorIdx = lastHistoryIdx >= 0 ? lastHistoryIdx : points.length - 1;

    const chartData = points.map((p, i) => {
      const row: Record<string, number | string | null> = {
        local_date: p.local_date,
        label: formatShortDateLabel(p.local_date),
        actual_pm25: p.actual_pm25,
      };
      for (const m of models) {
        // Anchor each forecast line to the last known actual so it visually
        // diverges from that point rather than starting mid-air.
        row[m] = p.predicted[m] ?? (i === anchorIdx ? p.actual_pm25 : null);
      }
      return row;
    });

    return {
      data: chartData,
      availableModels: [...models],
      todayLabel: points[anchorIdx]?.local_date ? formatShortDateLabel(points[anchorIdx].local_date) : undefined,
    };
  }, [points]);

  const minWidth = Math.max(680, data.length * 26);

  return (
    <ChartScrollContainer minWidth={minWidth} height={340}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
          <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="label"
            interval={Math.max(0, Math.floor(data.length / 12) - 1)}
            tick={{ fontSize: 11, fill: 'var(--muted)' }}
            tickMargin={8}
          />
          <YAxis
            width={40}
            tick={{ fontSize: 11, fill: 'var(--muted)' }}
            label={{ value: 'PM2.5 µg/m³', angle: -90, position: 'insideLeft', style: { fontSize: 11, fill: 'var(--muted)' } }}
          />
          <Tooltip
            contentStyle={{ background: 'var(--surface)', border: '1px solid var(--surface-border)', borderRadius: 8, fontSize: 12 }}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          {todayLabel && (
            <ReferenceLine x={todayLabel} stroke="var(--muted)" strokeDasharray="2 2" label={{ value: 'Today', position: 'top', fontSize: 11, fill: 'var(--muted)' }} />
          )}
          <Line type="monotone" dataKey="actual_pm25" name="Observed" stroke="var(--foreground)" strokeWidth={2} dot={false} connectNulls={false} />
          {availableModels.map((m) => (
            <Line
              key={m}
              type="monotone"
              dataKey={m}
              name={MODEL_LABELS[m]}
              stroke={MODEL_COLOR[m]}
              strokeWidth={1.75}
              strokeDasharray={MODEL_DASH[m]}
              dot={false}
              connectNulls={false}
            />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
    </ChartScrollContainer>
  );
}
