-- ===========================================================================
-- 0008 — admit `rolling_mean` as a fourth prediction model.
--
-- APPLY THIS BEFORE MERGING THE data-rolling-lag BRANCH. Early is safe; late
-- is not. The reasoning is at the bottom of this header, and it is the whole
-- point of splitting this away from 0009, whose ordering is the OPPOSITE.
--
-- ---------------------------------------------------------------------------
-- Why 0008 and not 0007
-- ---------------------------------------------------------------------------
-- 0007_jakarta_regions.sql exists. Numbering gaps are precedent in this repo
-- (0005 never existed), and two migrations sharing an ordinal is a real hazard
-- rather than a tidiness complaint: they sort ambiguously, and whichever is
-- applied second looks already-applied to anyone reading by number.
--
-- ---------------------------------------------------------------------------
-- What changes
-- ---------------------------------------------------------------------------
-- `predictions.model` gains 'rolling_mean' — the mean of the last N complete
-- daily means, carried forward unchanged across horizons 1-3, exactly as
-- `persistence` does with a single day.
--
-- `model_coefficients.model` is deliberately NOT widened. `rolling_mean` has
-- no fitted coefficients, which is precisely what lets it run for Bali and the
-- five Singapore regions where there is nothing to fit on. Its window comes
-- from ROLLING_MEAN_WINDOW_DAYS in src/lib/stations.ts, resolved independently
-- of the wind model's fitted window.
--
-- ---------------------------------------------------------------------------
-- Correcting an applied migration's comment, here rather than there
-- ---------------------------------------------------------------------------
-- 0002_views.sql describes `persistence` in terms that this branch makes
-- wrong. An applied migration is history and is not edited, so the correction
-- lives here:
--
--   `persistence` is no longer "today's running average carried forward". It
--   is the last COMPLETE local day's mean — the newest day strictly before
--   today with hours_count >= 12. It never uses the day in progress.
--
-- `model_accuracy`'s trailing-30-day averaging is unaffected and was never the
-- problem; the single-day dependency was on the INPUT side, in predict.ts.
--
-- ---------------------------------------------------------------------------
-- Why the constraint is found through the catalogue and not by text
-- ---------------------------------------------------------------------------
-- The CHECK is declared inline at 0001_init.sql:191, so Postgres auto-named it
-- and normalised the text. Written as
--     check (model in ('wind_regression', 'cams', 'persistence'))
-- it is stored as
--     CHECK ((model = ANY (ARRAY['wind_regression'::text, ...])))
--
-- 0006 was bitten by exactly this twice — once really, once by luck — and the
-- fix is already in this repo's git history ("Fix 0006: find the source
-- constraint by catalogue, not by text"). A pattern like '%model%in%' matches
-- the stored form only through the "in" inside a literal, so it evaporates the
-- moment a value is renamed: the drop silently does nothing and the ADD below
-- collides with the surviving name. `conkey` holds the columns a constraint
-- covers, so joining through pg_attribute finds every CHECK on `model`
-- whatever it is called. That is also what makes this migration re-runnable.
--
-- ---------------------------------------------------------------------------
-- WHY EARLY IS SAFE AND LATE IS NOT
-- ---------------------------------------------------------------------------
-- Early: the old code on main writes no `rolling_mean` rows. A CHECK that
-- permits a value nobody writes is inert. Nothing observes the difference.
--
-- Late: predict.ts collects every location x model row into ONE array and
-- upserts it in a SINGLE upsertChunked call, which THROWS on error
-- (scripts/lib/db.ts:160). One rejected `rolling_mean` row does not degrade to
-- three models for one location — it fails the whole statement and loses the
-- entire night's predictions, for every model and every location, including
-- the `cams` and `persistence` rows that had nothing to do with it.
--
-- The blast radius is the asymmetry. Apply this first.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- Drop whatever CHECK currently covers predictions.model, found structurally.
-- ---------------------------------------------------------------------------
do $$
declare
  con record;
begin
  for con in
    select c.conname
    from pg_constraint c
    join pg_attribute a
      on a.attrelid = c.conrelid
     and a.attnum = any (c.conkey)
    where c.conrelid = 'public.predictions'::regclass
      and c.contype = 'c'
      and a.attname = 'model'
  loop
    execute format('alter table public.predictions drop constraint %I', con.conname);
  end loop;
end $$;

-- The list must stay in lockstep with MODEL_FALLBACK_ORDER in src/lib/types.ts.
-- tests/thresholds.test.ts asserts the two contain EXACTLY the same members, in
-- both directions: a model added to TypeScript but not here fails the nightly
-- upsert outright, and a model added here but not to TypeScript is a value the
-- app can never render.
alter table public.predictions
  add constraint predictions_model_check
  check (model in ('wind_regression', 'cams', 'persistence', 'rolling_mean'));

comment on column public.predictions.model is
  'wind_regression | cams | persistence | rolling_mean. persistence = the last COMPLETE daily mean carried forward; rolling_mean = the mean of complete daily means over a trailing calendar window. Neither uses the day in progress. rolling_mean carries coefficients_id = null and, unlike wind_regression, is written for every location including those with no fitted model.';

commit;
