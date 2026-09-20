# Ingestion scheduling: why the hourly cron is not hourly

**Measured 2026-09-20.** `ingest-aq.yml` declares `cron: '17 * * * *'` — twenty-four runs a day.
GitHub actually started **five to seven**, every day, for a week:

```
2026-09-13  started=7   success:7
2026-09-14  started=5   success:5
2026-09-15  started=5   success:5
2026-09-16  started=6   success:6
2026-09-17  started=5   success:5
2026-09-18  started=6   success:6
2026-09-19  started=7   success:7
```

Every run succeeded. Nothing in this repository is failing. Roughly three quarters of the scheduled
triggers are simply never fired — GitHub's `schedule` event is best-effort, and it is being dropped
under load. `workflow_dispatch` is not subject to that behavior.

## Why this hurts Jabodetabek and not Singapore

The damage depends entirely on whether a source can backfill a missed hour. Distinct `observed_at`
values per station over 48 hours, where 48 would mean truly hourly:

| source | what one call returns | distinct hours / 48 |
|---|---|---|
| `datagovsg` | a **time series** | 45 |
| `airgradient` | current reading only | 28 |
| `waqi` | current reading only, ~1 h behind | 12 |

Singapore rides out the missed triggers because a single call recovers the gap. WAQI and AirGradient
only ever report *now*, so **every skipped trigger is an hour lost permanently**.

The consequence, in `daily_aq`, is that Indonesian locations plateau at 9–11 hours a day and rarely
clear `MIN_HOURS_FOR_SCORING` (12), while Singapore sits at a clean 24.

One useful accident: `ingest-airgradient.yml` runs `7,22,37,52 * * * *` — four attempts an hour — and
lands 28/48 hours against WAQI's 12/48 on one attempt an hour. Trigger density does buy coverage, at
roughly the rate a uniform ~75% drop predicts. (Inferred from the observation counts above; the
per-day run count for that workflow was not measured directly.)

## What this breaks, beyond a thin chart

`prediction_scores` refuses to score a day below 12 hours, so the same outage quietly starves the
accuracy board. Scored days out of the last 30, at horizon 1:

```
sg-*              28      jakarta-central   20      bali-denpasar      11
bsd               10      jakarta-south      9      jakarta-west        9
bekasi             6      jakarta-north      6
```

`bekasi` and `jakarta-north` are below `MIN_SCORED_DAYS_FOR_RANKING` (7), so they cannot rank models
on MAE at all and fall back to `MODEL_FALLBACK_ORDER`. Their published numbers are not a judgement
about the models; they are a judgement about the feed.

Treat a suspiciously *good* number at a thin location as a symptom, not a success. `jakarta-north`
showed a `persistence` MAE of 1.83 — a frozen feed scoring itself, its only station
(`waqi:-531679`) having not reported in 75 hours.

## The fix: drive the trigger externally

Every workflow here already declares `workflow_dispatch`, so nothing in the repository needs to
change. Point a free external scheduler at the GitHub API:

```
POST https://api.github.com/repos/MaxHasan/air-quality-forecast/actions/workflows/ingest-aq.yml/dispatches
Accept:               application/vnd.github+json
Authorization:        Bearer <TOKEN>
X-GitHub-Api-Version: 2022-11-28
Body:                 {"ref":"main"}
```

A 204 means accepted. Set it hourly at a minute that does **not** collide with `:17`, so the
surviving native trigger and the pinger do not both fire into the same `concurrency: ingest-aq`
group and cancel each other's value.

**The token.** A fine-grained PAT, scoped to this repository only, with **Actions: Read and write**
— that is the whole permission set it needs. Create it yourself and paste it into the scheduler;
it never belongs in this repository, in an environment variable here, or in a commit.

**Worth pinging:**

- `ingest-aq.yml` — hourly. The critical one; this is where the lost hours are.
- `predict-score.yml` — daily. Currently landing, but a dropped trigger here means **no forecast at
  all** that day, not merely a thinner one.

**Leave alone:** `ingest-airgradient.yml` already gets acceptable coverage from its four attempts an
hour, and `keepalive.yml` is weekly by design.

**Keep the existing `schedule:` blocks.** They cost nothing when they fire and are the fallback if
the external scheduler lapses.

### Status: live since 2026-09-20

Both pingers are configured and returning `204`, and — the part a `204` alone does not prove — a
dispatched run has actually landed and succeeded:

```
09-20T10:05  workflow_dispatch  completed success
09-20T06:13  schedule           completed success
09-20T01:06  schedule           completed success
```

The `schedule` entries above it are the surviving native triggers, roughly five hours apart, which
is the gap this exists to fill.

## What not to do

Do not respond to thin coverage by lowering `MIN_HOURS_FOR_SCORING`, or the rolling lag's
`lag_min_days` / `lag_min_hours`. Those are pinned to the definition the `wind_regression`
coefficients were **fitted** on (see `docs/backtests/2026-09-rolling-lag.md`), and `predict.ts`
reads them back off the coefficient row precisely so they cannot drift. Loosening them to fit an
outage would recreate the train/inference mismatch that migrations 0008–0010 exist to remove — and
it would do so invisibly, because the numbers would keep coming.

The bar is not the problem. The trigger is.

## Verifying it worked

Give it three days, then check that the numbers moved:

- `ingest-aq` runs per day should approach 24 (`gh run list --workflow=ingest-aq.yml`).
- `daily_aq.hours_count` for `jakarta-*`, `bsd` and `bekasi` should clear 12 on most days.
- `rolling_mean` should stop logging `only N complete day(s) ... below the minimum of 4` in the
  predict run for those locations.
- `model_accuracy.n` at horizon 1 should climb toward 30 for the Indonesian locations, and
  `bekasi` and `jakarta-north` should cross 7 and start ranking on MAE.

`jakarta-north` will not recover from scheduling alone — it has one station and that station is
dead. It needs a replacement feed, or it should be retired.
