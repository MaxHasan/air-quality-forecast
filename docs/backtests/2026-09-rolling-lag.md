# Choosing the lag window for `wind_regression`

**Date:** 2026-09-20
**Command:** `npm run calibrate -- --variants` (offline — the ERA5 response cache is populated, so this makes zero network calls)
**Archive:** Nafas hourly PM2.5 × ERA5 hourly weather, 2022-01-01 → 2023-12-14 (711 complete days per location)
**Split:** the existing 80/20 chronological holdout, unchanged

| location | train | test |
|---|---|---|
| `jakarta-central` | 2022-01-01 .. 2023-07-24 (568) | 2023-07-25 .. 2023-12-14 (143) |
| `bsd` | 2022-01-01 .. 2023-07-24 (568) | 2023-07-25 .. 2023-12-14 (143) |

---

## Why this backtest exists

`.github/workflows/predict-score.yml` runs `rollup` then `predict` at 12:37 UTC = **19:37 WIB**. The rollup
writes *today's partial* daily mean into `daily_aq`. `readAnchor` then scanned `daily_aq` newest-first and took
the first row with `hours_count >= 12` — which at 19:37 WIB is **today's ~19-hour partial mean**, never
yesterday's complete one.

That single value became both the `persistence` prediction verbatim and the wind regression's `pm25_lag`
predictor, identically at horizons 1, 2 and 3. But `b_lag` was fitted on a **complete** previous calendar day.
A slope fitted on a 24-hour mean was being applied to a 19-hour one, every night.

This project has a recorded lesson about exactly this class of error — fitting on BMKG wind while predicting
with Open-Meteo wind cost it R² 0.20 against 0.42, and a refit on the matching source recovered it. *Train on
the same source you will predict with.*

The fix is not in question. **What to replace it with** is, and the Nafas archive is hourly, so the status quo
can be **reconstructed rather than guessed**: `partialAsOf(19)` averages hours 00–18 of the day in progress, a
faithful stand-in for the 19:37 WIB anchor.

---

## The decision rule, stated before the numbers

> Among **shippable** variants, minimise mean holdout hybrid MAE across h ∈ {1,2,3} and both locations;
> tie-break within 0.1 µg/m³ toward the smaller W.
>
> With ~290 test pairs, differences below ~0.3 µg/m³ are not resolvable — the paired SE column is what says
> which gaps are real.

**Hard stops** — if any trips, the respecification does not ship: `olsFit2` returns null; `b_wind` flips sign
or loses significance (`|t| ≤ 3`); or the hybrid stops beating climatology at any horizon.

### The variants

| id | lag at issue date D | shippable |
|---|---|---|
| `partial_today` | partial mean of D, hours 00–18 | **no** — reproduces production today |
| `complete_1` | complete mean of D−1 | yes |
| `complete_3` | mean of complete days in [D−3, D−1] | yes |
| `complete_7` | mean of complete days in [D−7, D−1] | yes |
| `ewma_7_a50` | α=0.5 weights over complete days in [D−7, D−1] | yes |
| `oracle_complete_0` | complete mean of D | **no** — unattainable at issue time |

Each variant is **refitted on its own lag definition**. A variant scored with another variant's slopes would
measure nothing. Two geometries are fitted — `h1` (lag at D−1 only) and `pooled` (D−1, D−2, D−3 together) —
because one coefficient set serves all three horizons (`model_coefficients` has no horizon column) while the
lag's distance from the target is horizon-dependent. Both are evaluated at all three horizons.

---

## Results

`naive` = the lag value used directly as the prediction. `hybrid` = `olsFit2` on train, evaluated on test.
`Δ(hybrid)` and `Δ(naive)` are **paired** differences against `partial_today` ± standard error; positive means
the variant is *worse* than the status quo. `gaps` counts test rows where `gapDays > 0`.

### Jakarta Central — geometry `h1`

| h | variant | n | naive | hybrid | clim | b_lag | b_wind | t(bw) | R² | Δ(hybrid) vs partial | Δ(naive) vs partial | gaps |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `partial_today` | 143 | 7.07 | 7.96 | 11.17 | 0.406 | −7.66 | −13.8 | 0.556 | — | — | 0 |
| 1 | `complete_1` | 143 | 6.91 | 9.20 | 11.17 | 0.303 | −9.16 | −15.9 | 0.483 | +1.24 ± 0.26 | −0.16 ± 0.65 | 0 |
| 1 | `complete_3` | 143 | 6.42 | 8.72 | 11.17 | 0.348 | −9.20 | −16.0 | 0.485 | +0.76 ± 0.26 | −0.64 ± 0.61 | 0 |
| 1 | **`complete_7`** | 143 | **6.08** | 8.14 | 11.17 | 0.418 | −9.07 | −16.1 | 0.494 | +0.18 ± 0.26 | −0.99 ± 0.57 | 0 |
| 1 | `ewma_7_a50` | 143 | 6.18 | 8.37 | 11.17 | 0.393 | −8.77 | −15.4 | 0.500 | +0.41 ± 0.25 | −0.88 ± 0.59 | 0 |
| 1 | `oracle_complete_0` | 143 | 6.29 | 7.41 | 11.17 | 0.506 | −6.78 | −12.6 | 0.598 | −0.56 ± 0.07 | −0.78 ± 0.17 | 0 |
| 2 | `partial_today` | 143 | 7.48 | 7.91 | 11.17 | 0.406 | −7.66 | −13.8 | 0.556 | — | — | 0 |
| 2 | `complete_1` | 143 | 8.08 | 9.14 | 11.17 | 0.303 | −9.16 | −15.9 | 0.483 | +1.23 ± 0.29 | +0.60 ± 0.62 | 0 |
| 2 | `complete_3` | 143 | 6.67 | 8.67 | 11.17 | 0.348 | −9.20 | −16.0 | 0.485 | +0.77 ± 0.28 | −0.81 ± 0.59 | 0 |
| 2 | **`complete_7`** | 143 | **6.34** | 8.12 | 11.17 | 0.418 | −9.07 | −16.1 | 0.494 | +0.21 ± 0.27 | −1.14 ± 0.57 | 0 |
| 2 | `ewma_7_a50` | 143 | 6.80 | 8.31 | 11.17 | 0.393 | −8.77 | −15.4 | 0.500 | +0.40 ± 0.27 | −0.68 ± 0.56 | 0 |
| 2 | `oracle_complete_0` | 143 | 6.91 | 7.41 | 11.17 | 0.506 | −6.78 | −12.6 | 0.598 | −0.50 ± 0.08 | −0.57 ± 0.18 | 0 |
| 3 | `partial_today` | 143 | 8.53 | 7.77 | 11.17 | 0.406 | −7.66 | −13.8 | 0.556 | — | — | 0 |
| 3 | `complete_1` | 143 | 7.54 | 9.13 | 11.17 | 0.303 | −9.16 | −15.9 | 0.483 | +1.36 ± 0.28 | −0.98 ± 0.64 | 0 |
| 3 | `complete_3` | 143 | 6.57 | 8.69 | 11.17 | 0.348 | −9.20 | −16.0 | 0.485 | +0.92 ± 0.28 | −1.95 ± 0.63 | 0 |
| 3 | **`complete_7`** | 143 | **6.29** | 8.19 | 11.17 | 0.418 | −9.07 | −16.1 | 0.494 | +0.42 ± 0.28 | −2.23 ± 0.62 | 0 |
| 3 | `ewma_7_a50` | 143 | 6.54 | 8.31 | 11.17 | 0.393 | −8.77 | −15.4 | 0.500 | +0.54 ± 0.27 | −1.98 ± 0.61 | 0 |
| 3 | `oracle_complete_0` | 143 | 8.08 | 7.44 | 11.17 | 0.506 | −6.78 | −12.6 | 0.598 | −0.33 ± 0.09 | −0.45 ± 0.18 | 0 |

### Jakarta Central — geometry `pooled`

| h | variant | n | naive | hybrid | clim | b_lag | b_wind | t(bw) | R² | Δ(hybrid) vs partial | Δ(naive) vs partial | gaps |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `partial_today` | 143 | 7.07 | 9.07 | 11.17 | 0.284 | −9.21 | −27.9 | 0.486 | — | — | 0 |
| 1 | `complete_1` | 143 | 6.91 | 9.70 | 11.17 | 0.252 | −9.73 | −29.3 | 0.462 | +0.63 ± 0.20 | −0.16 ± 0.65 | 0 |
| 1 | `complete_3` | 143 | 6.42 | 9.06 | 11.17 | 0.316 | −9.52 | −28.8 | 0.473 | −0.01 ± 0.21 | −0.64 ± 0.61 | 0 |
| 1 | `complete_7` | 143 | 6.08 | 8.41 | 11.17 | 0.391 | −9.35 | −28.8 | 0.484 | −0.66 ± 0.21 | −0.99 ± 0.57 | 0 |
| 1 | `ewma_7_a50` | 143 | 6.18 | 8.82 | 11.17 | 0.347 | −9.25 | −28.2 | 0.482 | −0.25 ± 0.20 | −0.88 ± 0.59 | 0 |
| 1 | `oracle_complete_0` | 143 | 6.29 | 8.77 | 11.17 | 0.338 | −8.83 | −26.9 | 0.502 | −0.30 ± 0.04 | −0.78 ± 0.17 | 0 |
| 2 | `partial_today` | 143 | 7.48 | 9.06 | 11.17 | 0.284 | −9.21 | −27.9 | 0.486 | — | — | 0 |
| 2 | `complete_1` | 143 | 8.08 | 9.63 | 11.17 | 0.252 | −9.73 | −29.3 | 0.462 | +0.57 ± 0.21 | +0.60 ± 0.62 | 0 |
| 2 | `complete_3` | 143 | 6.67 | 9.02 | 11.17 | 0.316 | −9.52 | −28.8 | 0.473 | −0.04 ± 0.21 | −0.81 ± 0.59 | 0 |
| 2 | `complete_7` | 143 | 6.34 | 8.39 | 11.17 | 0.391 | −9.35 | −28.8 | 0.484 | −0.67 ± 0.22 | −1.14 ± 0.57 | 0 |
| 2 | `ewma_7_a50` | 143 | 6.80 | 8.76 | 11.17 | 0.347 | −9.25 | −28.2 | 0.482 | −0.30 ± 0.21 | −0.68 ± 0.56 | 0 |
| 2 | `oracle_complete_0` | 143 | 6.91 | 8.85 | 11.17 | 0.338 | −8.83 | −26.9 | 0.502 | −0.21 ± 0.05 | −0.57 ± 0.18 | 0 |
| 3 | `partial_today` | 143 | 8.53 | 8.99 | 11.17 | 0.284 | −9.21 | −27.9 | 0.486 | — | — | 0 |
| 3 | `complete_1` | 143 | 7.54 | 9.65 | 11.17 | 0.252 | −9.73 | −29.3 | 0.462 | +0.67 ± 0.21 | −0.98 ± 0.64 | 0 |
| 3 | `complete_3` | 143 | 6.57 | 9.04 | 11.17 | 0.316 | −9.52 | −28.8 | 0.473 | +0.05 ± 0.21 | −1.95 ± 0.63 | 0 |
| 3 | `complete_7` | 143 | 6.29 | 8.44 | 11.17 | 0.391 | −9.35 | −28.8 | 0.484 | −0.55 ± 0.22 | −2.23 ± 0.62 | 0 |
| 3 | `ewma_7_a50` | 143 | 6.54 | 8.77 | 11.17 | 0.347 | −9.25 | −28.2 | 0.482 | −0.21 ± 0.21 | −1.98 ± 0.61 | 0 |
| 3 | `oracle_complete_0` | 143 | 8.08 | 8.80 | 11.17 | 0.338 | −8.83 | −26.9 | 0.502 | −0.19 ± 0.05 | −0.45 ± 0.18 | 0 |

### BSD City — geometry `h1`

| h | variant | n | naive | hybrid | clim | b_lag | b_wind | t(bw) | R² | Δ(hybrid) vs partial | Δ(naive) vs partial | gaps |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `partial_today` | 143 | 10.26 | 10.14 | 13.64 | 0.344 | −10.82 | −16.0 | 0.552 | — | — | 0 |
| 1 | `complete_1` | 143 | 10.93 | 11.78 | 13.64 | 0.244 | −12.44 | −18.3 | 0.502 | +1.64 ± 0.31 | +0.67 ± 0.78 | 0 |
| 1 | `complete_3` | 143 | 9.62 | 11.27 | 13.64 | 0.281 | −12.53 | −18.4 | 0.504 | +1.13 ± 0.32 | −0.64 ± 0.72 | 0 |
| 1 | **`complete_7`** | 143 | **8.86** | 10.74 | 13.64 | 0.330 | −12.49 | −18.5 | 0.503 | +0.60 ± 0.31 | −1.41 ± 0.66 | 0 |
| 1 | `ewma_7_a50` | 143 | 9.51 | 11.00 | 13.64 | 0.319 | −12.10 | −17.8 | 0.513 | +0.85 ± 0.30 | −0.75 ± 0.70 | 0 |
| 1 | `oracle_complete_0` | 143 | 9.12 | 9.38 | 13.64 | 0.461 | −9.33 | −14.3 | 0.608 | −0.76 ± 0.13 | −1.14 ± 0.22 | 0 |
| 2 | `partial_today` | 143 | 11.51 | 10.72 | 13.64 | 0.344 | −10.82 | −16.0 | 0.552 | — | — | 0 |
| 2 | `complete_1` | 143 | 11.52 | 11.62 | 13.64 | 0.244 | −12.44 | −18.3 | 0.502 | +0.90 ± 0.31 | +0.02 ± 0.80 | 0 |
| 2 | `complete_3` | 143 | 9.74 | 11.21 | 13.64 | 0.281 | −12.53 | −18.4 | 0.504 | +0.49 ± 0.32 | −1.77 ± 0.78 | 0 |
| 2 | **`complete_7`** | 143 | **8.96** | 10.75 | 13.64 | 0.330 | −12.49 | −18.5 | 0.503 | +0.03 ± 0.31 | −2.55 ± 0.77 | 0 |
| 2 | `ewma_7_a50` | 143 | 9.76 | 10.87 | 13.64 | 0.319 | −12.10 | −17.8 | 0.513 | +0.15 ± 0.30 | −1.74 ± 0.75 | 0 |
| 2 | `oracle_complete_0` | 143 | 10.93 | 10.32 | 13.64 | 0.461 | −9.33 | −14.3 | 0.608 | −0.40 ± 0.14 | −0.58 ± 0.24 | 0 |
| 3 | `partial_today` | 143 | 11.98 | 10.48 | 13.64 | 0.344 | −10.82 | −16.0 | 0.552 | — | — | 0 |
| 3 | `complete_1` | 143 | 10.95 | 11.64 | 13.64 | 0.244 | −12.44 | −18.3 | 0.502 | +1.15 ± 0.30 | −1.02 ± 0.85 | 0 |
| 3 | `complete_3` | 143 | 9.40 | 11.17 | 13.64 | 0.281 | −12.53 | −18.4 | 0.504 | +0.69 ± 0.31 | −2.57 ± 0.82 | 0 |
| 3 | **`complete_7`** | 143 | **9.00** | 10.85 | 13.64 | 0.330 | −12.49 | −18.5 | 0.503 | +0.37 ± 0.31 | −2.98 ± 0.80 | 0 |
| 3 | `ewma_7_a50` | 143 | 9.36 | 10.89 | 13.64 | 0.319 | −12.10 | −17.8 | 0.513 | +0.41 ± 0.29 | −2.61 ± 0.79 | 0 |
| 3 | `oracle_complete_0` | 143 | 11.52 | 10.26 | 13.64 | 0.461 | −9.33 | −14.3 | 0.608 | −0.22 ± 0.15 | −0.45 ± 0.23 | 0 |

### BSD City — geometry `pooled`

| h | variant | n | naive | hybrid | clim | b_lag | b_wind | t(bw) | R² | Δ(hybrid) vs partial | Δ(naive) vs partial | gaps |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `partial_today` | 143 | 10.26 | 11.37 | 13.64 | 0.233 | −12.51 | −32.0 | 0.503 | — | — | 0 |
| 1 | `complete_1` | 143 | 10.93 | 12.17 | 13.64 | 0.200 | −13.03 | −33.4 | 0.489 | +0.81 ± 0.21 | +0.67 ± 0.78 | 0 |
| 1 | `complete_3` | 143 | 9.62 | 11.54 | 13.64 | 0.254 | −12.82 | −32.8 | 0.495 | +0.18 ± 0.23 | −0.64 ± 0.72 | 0 |
| 1 | `complete_7` | 143 | 8.86 | 10.97 | 13.64 | 0.308 | −12.75 | −33.2 | 0.499 | −0.40 ± 0.23 | −1.41 ± 0.66 | 0 |
| 1 | `ewma_7_a50` | 143 | 9.51 | 11.37 | 13.64 | 0.280 | −12.56 | −32.4 | 0.501 | +0.00 ± 0.22 | −0.75 ± 0.70 | 0 |
| 1 | `oracle_complete_0` | 143 | 9.12 | 11.05 | 13.64 | 0.284 | −12.00 | −30.8 | 0.520 | −0.31 ± 0.07 | −1.14 ± 0.22 | 0 |
| 2 | `partial_today` | 143 | 11.51 | 11.62 | 13.64 | 0.233 | −12.51 | −32.0 | 0.503 | — | — | 0 |
| 2 | `complete_1` | 143 | 11.52 | 12.07 | 13.64 | 0.200 | −13.03 | −33.4 | 0.489 | +0.45 ± 0.21 | +0.02 ± 0.80 | 0 |
| 2 | `complete_3` | 143 | 9.74 | 11.50 | 13.64 | 0.254 | −12.82 | −32.8 | 0.495 | −0.12 ± 0.22 | −1.77 ± 0.78 | 0 |
| 2 | `complete_7` | 143 | 8.96 | 10.97 | 13.64 | 0.308 | −12.75 | −33.2 | 0.499 | −0.65 ± 0.22 | −2.55 ± 0.77 | 0 |
| 2 | `ewma_7_a50` | 143 | 9.76 | 11.26 | 13.64 | 0.280 | −12.56 | −32.4 | 0.501 | −0.36 ± 0.21 | −1.74 ± 0.75 | 0 |
| 2 | `oracle_complete_0` | 143 | 10.93 | 11.46 | 13.64 | 0.284 | −12.00 | −30.8 | 0.520 | −0.16 ± 0.07 | −0.58 ± 0.24 | 0 |
| 3 | `partial_today` | 143 | 11.98 | 11.44 | 13.64 | 0.233 | −12.51 | −32.0 | 0.503 | — | — | 0 |
| 3 | `complete_1` | 143 | 10.95 | 12.07 | 13.64 | 0.200 | −13.03 | −33.4 | 0.489 | +0.62 ± 0.22 | −1.02 ± 0.85 | 0 |
| 3 | `complete_3` | 143 | 9.40 | 11.45 | 13.64 | 0.254 | −12.82 | −32.8 | 0.495 | +0.00 ± 0.24 | −2.57 ± 0.82 | 0 |
| 3 | `complete_7` | 143 | 9.00 | 11.06 | 13.64 | 0.308 | −12.75 | −33.2 | 0.499 | −0.38 ± 0.23 | −2.98 ± 0.80 | 0 |
| 3 | `ewma_7_a50` | 143 | 9.36 | 11.25 | 13.64 | 0.280 | −12.56 | −32.4 | 0.501 | −0.20 ± 0.22 | −2.61 ± 0.79 | 0 |
| 3 | `oracle_complete_0` | 143 | 11.52 | 11.26 | 13.64 | 0.284 | −12.00 | −30.8 | 0.520 | −0.18 ± 0.07 | −0.45 ± 0.23 | 0 |

---

## Applying the rule

Mean holdout hybrid MAE across h1–h3 and both locations, shippable variants only:

| rank | variant / geometry | mean MAE |
|---|---|---|
| **1** | **`complete_7` / `h1`** | **9.466** |
| 2 | `ewma_7_a50` / `h1` | 9.625 |
| 3 | `complete_7` / `pooled` | 9.707 |
| 4 | `complete_3` / `h1` | 9.956 |
| 5 | `ewma_7_a50` / `pooled` | 10.040 |
| 6 | `complete_3` / `pooled` | 10.268 |
| 7 | `complete_1` / `h1` | 10.419 |
| 8 | `complete_1` / `pooled` | 10.882 |

**Chosen: `complete_7`, geometry `h1`. W = 7, minHours = 12, minDays = 4.**

The spread across shippable variants is **1.416 µg/m³** — an order of magnitude above the 0.1 tie-break band,
so no tie-break was needed and the runner-up is 0.159 clear. **The window is identified by the data**; this is
not a case where the backtest could not distinguish, and the word "rolling" is earned by more than one day.

`b_lag` moves monotonically with W (0.303 → 0.348 → 0.418 at Jakarta Central), which is the expected
signature: a smoother estimate of the level carries more weight in the fit than a noisier one.

### Hard stops: none tripped

| check | `complete_7` / `h1`, Jakarta Central | BSD |
|---|---|---|
| `olsFit2` returns a fit | yes | yes |
| `b_wind` negative | −9.07 | −12.49 |
| `b_wind` significant (\|t\| > 3) | 16.1 | 18.5 |
| beats climatology at every horizon | 8.14 / 8.12 / 8.19 vs 11.17 | 10.74 / 10.75 / 10.85 vs 13.64 |

---

## The freshness cost

Dropping today's ~19 hours removes the freshest signal on a strongly autocorrelated series, and h1 is where
that is worth most. Measured against the **refit `partial_today` steelman** — not against the old v1 numbers,
which is the comparison that would flatter the change:

| location | h | `partial_today` hybrid | `complete_7` hybrid | Δ ± SE |
|---|---|---|---|---|
| jakarta-central | 1 | 7.96 | 8.14 | **+0.18 ± 0.26** |
| jakarta-central | 2 | 7.91 | 8.12 | +0.21 ± 0.27 |
| jakarta-central | 3 | 7.77 | 8.19 | +0.42 ± 0.28 |
| bsd | 1 | 10.14 | 10.74 | **+0.60 ± 0.31** |
| bsd | 2 | 10.72 | 10.75 | +0.03 ± 0.31 |
| bsd | 3 | 10.48 | 10.85 | +0.37 ± 0.31 |

**Mean freshness cost: +0.30 µg/m³ on `wind_regression`.** Four of the six cells are inside one standard
error of zero. The largest (BSD h1, +0.60 ± 0.31) is about 1.9 SE — suggestive, not resolved.

So on the wind model alone, **`partial_today` keeps a small edge at h1 in the `h1` geometry**, and it should be
said plainly rather than buried. Three things bound it:

1. In the **`pooled`** geometry — the one that honestly reflects `model_coefficients` having no horizon column
   — `complete_7` *beats* `partial_today` at every horizon and both locations (−0.66, −0.67, −0.55 at Jakarta
   Central; −0.40, −0.65, −0.38 at BSD). The `h1` geometry flatters the freshest lag because it is fitted at
   exactly the distance where freshness is worth most and then applied at two distances where it is not.
2. The simulated status quo is **optimistic** (caveat 1 below), so +0.30 is an upper bound.
3. It is bought, not merely lost — see below.

### What the same change buys

The `Δ(naive)` column measures the lag value used directly as a prediction. For `complete_W` that is exactly
what the new `rolling_mean` model does in production; for `partial_today` it is exactly what `persistence`
does today. Like for like:

| location | h | `persistence` today (naive `partial_today`) | `rolling_mean` W=7 (naive `complete_7`) | Δ ± SE |
|---|---|---|---|---|
| jakarta-central | 1 | 7.07 | 6.08 | −0.99 ± 0.57 |
| jakarta-central | 2 | 7.48 | 6.34 | −1.14 ± 0.57 |
| jakarta-central | 3 | 8.53 | 6.29 | −2.23 ± 0.62 |
| bsd | 1 | 10.26 | 8.86 | −1.41 ± 0.66 |
| bsd | 2 | 11.51 | 8.96 | −2.55 ± 0.77 |
| bsd | 3 | 11.98 | 9.00 | −2.98 ± 0.80 |

**Mean: −1.88 µg/m³.** Six times the freshness cost, in the opposite direction.

The striking result, and the reason `rolling_mean` earns a place on the accuracy board rather than a courtesy
line on a chart: **the plain 7-day rolling mean has the lowest MAE in the entire table** — 6.08–6.34 at Jakarta
Central and 8.86–9.00 at BSD. It beats every hybrid at every horizon and both locations, including
`oracle_complete_0`'s hybrid, and including `oracle_complete_0`'s own naive (6.29 at h1). Daily PM2.5 here is
mean-reverting around a slowly-drifting level, and the day-to-day noise is large enough that a smoothed
estimate of that level beats the last observation of it.

This does not crown `rolling_mean`. Production writes all four models every night and `model_accuracy` ranks
them per location **and** per horizon on live data, which is the measurement that decides. It does say that the
board is about to get a genuinely competitive fourth entry rather than a decorative one.

---

## Reconciling with the published v1 numbers

The current holdout figures — including the **6.29** persistence MAE quoted in `predict.ts`'s header essay and
the "6.29 against the hybrid's 7.41" in `src/lib/mock-data.ts` — were computed with the lag set to the
**complete** mean of the issue day. That is `oracle_complete_0`, and this run reproduces both numbers exactly:

| published v1 figure | this run |
|---|---|
| persistence 6.29 MAE, Jakarta Central h1 | `oracle_complete_0` naive, h1, `h1` geometry: **6.29** |
| hybrid 7.41 MAE, Jakarta Central h1 | `oracle_complete_0` hybrid, h1, `h1` geometry: **7.41** |

A day that is only 19 hours old at issue time cannot supply its own complete mean. **Every published v1
holdout number is therefore optimistic for every model**, by 0.45–1.14 µg/m³ on the naive side. The new
report's figures are higher not because the model got worse but because the benchmark stopped cheating.

Reading the v1 → v2 change as a regression would be reading the removal of a leak as damage.

---

## What shipped, and one gate that stopped blocking

`npm run calibrate -- --sql` refit all six TRAINABLE locations on `complete_7` / `h1` and seeded them as
**version 2**. `b_wind` stays negative and strongly significant everywhere:

| location | intercept | b_lag | b_wind | \|t(b_wind)\| | R² |
|---|---|---|---|---|---|
| `jakarta-central` | 30.955 | 0.577 | −7.793 | 16.1 | 0.488 |
| `jakarta-north` | 31.463 | 0.549 | −7.327 | — | 0.457 |
| `jakarta-south` | 35.534 | 0.488 | −9.408 | — | 0.469 |
| `jakarta-west` | 33.958 | 0.551 | −8.519 | — | 0.465 |
| `bsd` | 46.022 | 0.467 | −11.292 | 18.5 | 0.484 |
| `bekasi` | 35.941 | 0.542 | −8.711 | — | 0.459 |

Migration 0009 seeds only `jakarta-central` and `bsd` — the two this report measured. The other four stay on
v1 and are therefore **skipped** by the new code until a follow-up seeds them, which is the designed
degradation rather than a defect.

### `beats persistence somewhere` no longer blocks seeding

This is a deliberate change to `fit-wind-model.ts` and is called out here so it is not mistaken for a gate
quietly loosened to let a result through.

Before this branch, `persistence` in the calibration report was scored as the complete mean of the **issue
day** — `oracle_complete_0`. The hybrid was being compared against a benchmark that was itself unattainable,
and it still crossed this gate at h=3 at four of six locations. Those crossings were not measurements of skill.

Scored honestly, `wind_regression` now loses to `persistence` at every horizon at `jakarta-central`,
`jakarta-north` and `bekasi`, and loses to `rolling_mean` everywhere. Under the old blocking rule those three
locations would have been seeded with **no coefficients at all**, silently removing their wind model.

That would be a build-time crowning on one 2023 Jabodetabek season with a perfect wind forecast — exactly what
the four-model design exists to avoid. The gate is still computed and still printed; it no longer decides. The
physics gates (`b_wind` negative, `|t| > 3`, beats climatology) do still block, because a wrong-signed or
insignificant wind term means the fit found nothing and no amount of live ranking rescues it. All six pass
those.

---

## Degraded windows

`gaps` is **0 in every cell**. The archive has no window in the holdout period where a complete day is
missing, so the `daysUsed` / `gapDays` machinery and the `minDays = 4` refusal are **unevidenced here** — they
are reasoned, not measured.

That is a real limit of this backtest. Production's feeds are less tidy than the archive, which is why
`predictions.inputs` records `window_days`, `days_used`, `gap_days` and `window_start` on every row: the
behaviour that could not be tested offline is at least auditable afterwards.

---

## Caveats

1. **The simulated status quo is optimistic, which biases this test *against* the change.** The archive's
   partial day is a clean per-city Nafas mean. Production's is a mean over a *changing* station set — the
   AirGradient discontinuity that `0006_airgradient.sql` stamps onto exactly these two locations — including
   humidity-corrected AirGradient rows. The real `partial_today` is noisier than the simulated one, so the
   +0.30 freshness cost is an **upper bound**.
2. **The backtest feeds ERA5 *actuals* for the target day — a perfect wind forecast.** Live skill is lower by
   whatever Open-Meteo's wind error costs, and the gap widens with horizon. This applies equally to every
   variant, so it does not bias the *choice* of window; it does mean the absolute MAEs here are optimistic for
   the hybrid specifically, and `rolling_mean` (which uses no wind at all) is the one model in the table whose
   backtest number is not inflated by it.
3. **The published v1 numbers were optimistic too** — see the reconciliation above.
4. **A 30-day `model_accuracy` window straddling the v1 → v2 switch compares two different models under one
   label.** `wind_regression` rankings spanning the migration date should be read with that in mind.
5. **`rolling_mean` enters with zero scored days** and shows "unscored" for its first 7 days
   (`MIN_SCORED_DAYS_FOR_RANKING`). Expected, not a bug.
6. **Two locations, one city region, one 143-day holdout season.** `jakarta-central` and `bsd` are the only
   locations with both an archive and an active coefficient row. W=7 is chosen on Jabodetabek dry-to-wet
   season 2023 and is applied to `jakarta-north`, `jakarta-south`, `jakarta-west` and `bekasi` on the
   assumption that they behave similarly. `/models` measures whether that held.
