import Link from 'next/link';
import type { IngestionHealth } from '@/lib/types';

function timeAgo(iso: string | null): string {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

interface IngestionFooterProps {
  health: IngestionHealth;
}

/** Site footer: attribution links plus an honest read on data-pipeline health. */
export function IngestionFooter({ health }: IngestionFooterProps) {
  const degraded = health.failure_streak > 0 || health.latest?.status === 'error';

  return (
    <footer className="mt-12 border-t border-surface-border bg-surface-muted">
      <div className="mx-auto flex max-w-5xl flex-col gap-3 px-4 py-6 text-xs text-muted sm:px-6">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <Link href="/about" className="underline hover:text-accent">
            About &amp; attributions
          </Link>
          <Link href="/models" className="underline hover:text-accent">
            Model accuracy
          </Link>
          <span aria-hidden>·</span>
          <span>
            PM2.5 data via{' '}
            <a href="https://aqicn.org" target="_blank" rel="noopener noreferrer" className="underline hover:text-accent">
              WAQI
            </a>{' '}
            and{' '}
            <a href="https://data.gov.sg" target="_blank" rel="noopener noreferrer" className="underline hover:text-accent">
              data.gov.sg
            </a>
            ; weather via{' '}
            <a href="https://open-meteo.com" target="_blank" rel="noopener noreferrer" className="underline hover:text-accent">
              Open-Meteo
            </a>
            .
          </span>
        </div>

        <div className="flex items-center gap-2">
          <span
            aria-hidden
            className={`inline-block h-2 w-2 rounded-full ${degraded ? 'bg-warning' : 'bg-positive'}`}
          />
          <span>
            {degraded
              ? `Ingestion degraded — ${health.failure_streak} run${health.failure_streak === 1 ? '' : 's'} short of clean since ${timeAgo(health.last_ok_at)}.`
              : `Ingestion healthy — last confirmed ${timeAgo(health.last_ok_at)}.`}
          </span>
        </div>

        {degraded && health.latest?.error && <p className="max-w-3xl text-[11px] italic text-muted">{health.latest.error}</p>}

        <p className="text-[11px] text-muted">
          Personal, non-commercial project. Cached observations are stored for model training only and are not
          redistributed. Verdicts are planning heuristics, not medical advice.
        </p>
      </div>
    </footer>
  );
}
