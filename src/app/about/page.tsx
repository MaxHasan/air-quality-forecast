import type { Metadata } from 'next';
import { ActivityGuide, AqiScaleTable } from '@/components/AqiScale';
import { MODEL_DESCRIPTIONS, MODEL_LABELS } from '@/lib/display';
import { MODEL_FALLBACK_ORDER } from '@/lib/types';

export const metadata: Metadata = {
  title: 'About',
};

export default function AboutPage() {
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-10 px-4 py-8 sm:px-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-bold sm:text-3xl">About</h1>
        <p className="text-sm text-muted">Why this exists, how it works, and who the underlying data belongs to.</p>
      </header>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">The story</h2>
        <p className="text-sm leading-relaxed text-muted">
          This app grew out of a personal analysis of two years of hourly PM2.5 readings across ten Jabodetabek
          cities (from the Nafas sensor network) against BMKG&apos;s daily weather records. The headline finding: the
          previous day&apos;s average wind speed — not rainfall, which barely moved the needle — is a strong
          predictor of tomorrow&apos;s PM2.5 in greater Jakarta. Stronger wind disperses the haze; calm days let it
          build up. Wind direction matters too, seasonally, tracking the shift between the dry-season easterlies and
          the wet-season north-westerlies.
        </p>
        <p className="text-sm leading-relaxed text-muted">
          The full write-up, with the regression details and charts, is on Substack:{' '}
          <a
            href="https://hasanalyzed.substack.com/p/masuk-angin-nafas-lega"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-accent"
          >
            &quot;Masuk Angin, Nafas Lega&quot;
          </a>
          . This app operationalizes that model — fitted per region — so it can answer a simple question the night
          before: is tomorrow a good day for a run, a swim, or a walk with the newborn?
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Three models, one answer</h2>
        <p className="text-sm leading-relaxed text-muted">
          Rather than trust a single predictor, every location gets three independent forecasts, scored daily against
          what actually happened. The headline number on each card is whichever model has the lowest error over the
          trailing 30 days — see{' '}
          <a href="/models" className="underline hover:text-accent">
            model accuracy
          </a>{' '}
          for the full board.
        </p>
        <dl className="flex flex-col gap-3">
          {MODEL_FALLBACK_ORDER.map((m) => (
            <div key={m} className="rounded-xl border border-surface-border bg-surface p-4">
              <dt className="font-semibold">{MODEL_LABELS[m]}</dt>
              <dd className="text-sm text-muted">{MODEL_DESCRIPTIONS[m]}</dd>
            </div>
          ))}
        </dl>
        <p className="text-xs text-muted">
          New locations start on CAMS and persistence alone — honestly labelled &quot;calibrating&quot; — until
          enough ground truth accumulates to fit a wind regression of their own.
        </p>
      </section>

      <section id="reading-the-numbers" className="flex flex-col gap-3 scroll-mt-6">
        <h2 className="text-lg font-semibold">Reading the numbers</h2>
        <p className="text-sm leading-relaxed text-muted">
          The cards show <strong className="text-foreground">PM2.5</strong> — fine particulate matter 2.5 microns
          or smaller, about a thirtieth of the width of a hair, and the pollutant most strongly tied to health
          effects. It is measured in µg/m³ (micrograms per cubic meter of air). Many apps show an{' '}
          <strong className="text-foreground">AQI</strong> instead: an index that maps concentrations onto a 0–500
          scale with named, colour-coded bands. The two are often confused — an AQI of 155 is about 63 µg/m³, not
          155. This scale translates between them:
        </p>
        <AqiScaleTable />
        <h3 id="activities" className="pt-2 font-semibold scroll-mt-6">
          What the verdicts mean
        </h3>
        <p className="text-sm leading-relaxed text-muted">
          One number, three verdicts — because exposure isn&apos;t the same across activities. A hard run moves
          roughly ten times more air through your lungs than sitting still, and an infant in a stroller breathes
          more air per kilogram of body weight than an adult, closer to exhaust height. So the bar each activity
          must clear is different:
        </p>
        <ActivityGuide />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Data sources &amp; attribution</h2>
        <ul className="flex flex-col gap-3 text-sm text-muted">
          <li>
            <strong className="text-foreground">
              <a href="https://aqicn.org" target="_blank" rel="noopener noreferrer" className="underline hover:text-accent">
                World Air Quality Index (WAQI / aqicn.org)
              </a>
            </strong>{' '}
            republishes Indonesia&apos;s ground-truth PM2.5 feeds — BMKG (Badan Meteorologi, Klimatologi, dan
            Geofisika) and KLHK (Kementerian Lingkungan Hidup dan Kehutanan) stations. Used under WAQI&apos;s
            non-commercial terms; a courtesy notice describing this project&apos;s use has been sent to the WAQI team.
          </li>
          <li>
            <strong className="text-foreground">
              <a href="https://open-meteo.com" target="_blank" rel="noopener noreferrer" className="underline hover:text-accent">
                Open-Meteo
              </a>
            </strong>{' '}
            supplies wind speed/direction, temperature and the CAMS atmospheric PM2.5 forecast, licensed{' '}
            <a
              href="https://creativecommons.org/licenses/by/4.0/"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-accent"
            >
              CC-BY 4.0
            </a>
            .
          </li>
          <li>
            <strong className="text-foreground">
              <a href="https://data.gov.sg" target="_blank" rel="noopener noreferrer" className="underline hover:text-accent">
                data.gov.sg
              </a>
            </strong>{' '}
            provides Singapore&apos;s regional PM2.5 and weather readings (National Environment Agency), under the{' '}
            <a
              href="https://data.gov.sg/open-data-licence"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-accent"
            >
              Singapore Open Data Licence
            </a>
            .
          </li>
          <li>
            <strong className="text-foreground">BMKG</strong> (
            <a href="https://www.bmkg.go.id" target="_blank" rel="noopener noreferrer" className="underline hover:text-accent">
              bmkg.go.id
            </a>
            ) is Indonesia&apos;s official meteorological agency and the source of the 2022–2023 weather record the
            original wind model was fit on, in addition to feeding WAQI&apos;s Jakarta stations directly.
          </li>
        </ul>
      </section>

      <section className="flex flex-col gap-3 rounded-xl border border-surface-border bg-surface-muted p-5">
        <h2 className="text-lg font-semibold">Plain terms</h2>
        <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-muted">
          <li>This is a personal, non-commercial project — one household&apos;s planning tool, not a product.</li>
          <li>
            Cached observations are stored only to train and score the prediction models. They are not
            redistributed, bulk-exported, or exposed through a public API.
          </li>
          <li>
            Verdicts (&quot;Go&quot; / &quot;Caution&quot; / &quot;Avoid&quot;) are planning heuristics built on WHO
            and EPA guideline concentrations, not medical advice. If air quality is a health concern, especially for
            an infant, consult a clinician.
          </li>
        </ul>
      </section>
    </main>
  );
}
