'use client';

import { CartesianGrid, Legend, Line, ComposedChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { HourlyPoint } from '@/lib/types';
import { thresholdFor } from '@/lib/thresholds';
import { ChartScrollContainer } from './ChartScrollContainer';

interface WindOverlayChartProps {
  points: HourlyPoint[];
}

/**
 * Last-N-hours PM2.5 with wind speed on a secondary axis — the causal story
 * the whole app rests on: PM2.5 climbing as wind speed falls. Gaps in PM2.5
 * (a station outage) are left as real gaps (`connectNulls={false}`) rather
 * than papered over.
 */
export function WindOverlayChart({ points }: WindOverlayChartProps) {
  const newborn = thresholdFor('newborn_walk');
  const running = thresholdFor('running');
  const tickInterval = Math.max(0, Math.floor(points.length / 16) - 1);
  const minWidth = Math.max(640, points.length * 9);

  return (
    <ChartScrollContainer minWidth={minWidth} height={320}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={points} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
          <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="local_label" interval={tickInterval} tick={{ fontSize: 11, fill: 'var(--muted)' }} tickMargin={8} />
          <YAxis
            yAxisId="pm25"
            width={40}
            tick={{ fontSize: 11, fill: 'var(--muted)' }}
            label={{ value: 'PM2.5 µg/m³', angle: -90, position: 'insideLeft', style: { fontSize: 11, fill: 'var(--muted)' } }}
          />
          <YAxis
            yAxisId="wind"
            orientation="right"
            width={44}
            tick={{ fontSize: 11, fill: 'var(--muted)' }}
            label={{ value: 'Wind m/s', angle: 90, position: 'insideRight', style: { fontSize: 11, fill: 'var(--muted)' } }}
          />
          <ReferenceLine yAxisId="pm25" y={newborn.goMax} stroke="var(--positive)" strokeDasharray="4 4" strokeOpacity={0.5} />
          <ReferenceLine yAxisId="pm25" y={running.cautionMax} stroke="var(--negative)" strokeDasharray="4 4" strokeOpacity={0.5} />
          <Tooltip
            contentStyle={{ background: 'var(--surface)', border: '1px solid var(--surface-border)', borderRadius: 8, fontSize: 12 }}
            formatter={(value, name) => {
              if (value === null || value === undefined) return ['no data', name];
              return name === 'PM2.5 (µg/m³)' ? [`${value} µg/m³`, name] : [`${value} m/s`, name];
            }}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Line
            yAxisId="pm25"
            type="monotone"
            dataKey="pm25_ugm3"
            name="PM2.5 (µg/m³)"
            stroke="var(--chart-pm25)"
            strokeWidth={2}
            dot={false}
            connectNulls={false}
          />
          <Line
            yAxisId="wind"
            type="monotone"
            dataKey="wind_speed_ms"
            name="Wind speed (m/s)"
            stroke="var(--chart-wind)"
            strokeWidth={1.5}
            strokeDasharray="4 2"
            dot={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </ChartScrollContainer>
  );
}
