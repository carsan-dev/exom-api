-- ADH-FREEZE-01 (U5): retire the adherence journals without deleting anything.
--
-- The 16 row capture triggers that feed adherence_assignment_journal and
-- adherence_catalog_journal are DISABLED, not dropped: trigger definitions,
-- capture functions, journal tables and every existing journal row stay as
-- they are. Reversible per table with
--   ALTER TABLE public.<table> ENABLE TRIGGER <trigger>;
-- (the four trigger names and their tables are listed below).
--
-- Nothing in the API reads the journals; only the history origin/cut
-- machinery (operator scripts/adherence-history-operator.cjs and its SDK)
-- does. A cut over a window with uncaptured writes would be wrong without
-- any error, so activate_adherence_history_origin() now refuses to open an
-- epoch unless all 16 triggers are enabled (fail closed). Body otherwise
-- identical to 20261002050000; same signature, result, owner, ACL, invoker
-- security and search_path (CREATE OR REPLACE keeps owner, ACL and comment).
--
-- Limitation: the guard only covers NEW epochs. An epoch activated before
-- this migration is not invalidated, and its stored cuts remain readable
-- because their journal windows are fixed. A NEW cut on such an epoch would
-- miss every write made while the triggers are disabled; no code path issues
-- one (the operator only cuts inside the live lease of a fresh activation),
-- and running this migration during such a lease breaks the "no privileged
-- maintenance during the lease" prerequisite of the origin machinery.
--
-- Cutover: an activation already running the OLD body while this migration
-- waits for its table locks would open an epoch after the triggers are
-- disabled. The supported operator holds the session advisory lock (60309,31)
-- from before activation until its lease closes, so this migration first
-- tries the same lock and aborts (55P03, nothing changed) if it is held.
-- Residual limit: a direct call to the function (manual SQL, SDK or script)
-- that does not hold (60309,31) is not excluded; do not activate outside the
-- operator while this migration is being deployed.
BEGIN;
DO $$
BEGIN
  IF NOT pg_catalog.pg_try_advisory_xact_lock(60309, 31) THEN
    RAISE EXCEPTION 'Adherence history operator running (advisory lock 60309,31 held); retry after it ends'
      USING ERRCODE = '55P03';
  END IF;
END
$$;
-- Bounded wait: DISABLE TRIGGER takes SHARE ROW EXCLUSIVE on each table. All
-- 16 locks are requested up front, in the order of 20261002050000 and of the
-- activation/cut barrier (common13 alphabetical, then the three overlays), so
-- a busy table aborts the whole migration before any trigger is touched.
SET LOCAL lock_timeout = '5s';
LOCK TABLE public.catalog_colors, public.diet_groups, public.diets,
  public.exercises, public.ingredients, public.meal_ingredients, public.meals,
  public.plan_assignment_trainings, public.plan_assignments,
  public.training_blocks, public.training_exercises, public.training_groups,
  public.trainings, public.diet_day_snapshots, public.rir_day_targets,
  public.training_day_snapshots IN SHARE ROW EXCLUSIVE MODE;

-- 20261001010000 L50-55
ALTER TABLE public.plan_assignments DISABLE TRIGGER adherence_assignment_event;
ALTER TABLE public.plan_assignment_trainings DISABLE TRIGGER adherence_assignment_training_event;
-- 20261001030000 L99-107
ALTER TABLE public.trainings DISABLE TRIGGER adherence_catalog_event;
ALTER TABLE public.training_blocks DISABLE TRIGGER adherence_catalog_event;
ALTER TABLE public.training_exercises DISABLE TRIGGER adherence_catalog_event;
ALTER TABLE public.exercises DISABLE TRIGGER adherence_catalog_event;
ALTER TABLE public.training_groups DISABLE TRIGGER adherence_catalog_event;
ALTER TABLE public.diet_groups DISABLE TRIGGER adherence_catalog_event;
ALTER TABLE public.catalog_colors DISABLE TRIGGER adherence_catalog_event;
ALTER TABLE public.diets DISABLE TRIGGER adherence_catalog_event;
ALTER TABLE public.meals DISABLE TRIGGER adherence_catalog_event;
ALTER TABLE public.meal_ingredients DISABLE TRIGGER adherence_catalog_event;
ALTER TABLE public.ingredients DISABLE TRIGGER adherence_catalog_event;
-- 20261002050000 L75-89
ALTER TABLE public.diet_day_snapshots DISABLE TRIGGER adherence_effective_event;
ALTER TABLE public.rir_day_targets DISABLE TRIGGER adherence_effective_event;
ALTER TABLE public.training_day_snapshots DISABLE TRIGGER adherence_effective_event;

CREATE OR REPLACE FUNCTION public.activate_adherence_history_origin()
RETURNS TABLE(id text, activating_full_xid text)
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
    seq_oid regclass;
    qualified_sequence text;
    new_epoch text;
    boundary bigint;
    source text;
    system_identifier text;
    timeline integer;
    database_oid bigint;
    uncaptured text;
BEGIN
    PERFORM public.assert_adherence_commit_owner();
    IF current_setting('transaction_isolation') <> 'read committed' THEN
      RAISE EXCEPTION 'Fresh activation requires READ COMMITTED' USING ERRCODE = '25001';
    END IF;
    PERFORM set_config('lock_timeout', '5s', true);
    -- EXACT migration85 order and mode; drain all writers before any images.
    LOCK TABLE public.catalog_colors, public.diet_groups, public.diets,
      public.exercises, public.ingredients, public.meal_ingredients, public.meals,
      public.plan_assignment_trainings, public.plan_assignments,
      public.training_blocks, public.training_exercises, public.training_groups,
      public.trainings, public.diet_day_snapshots, public.rir_day_targets,
      public.training_day_snapshots IN SHARE ROW EXCLUSIVE MODE;
    -- Fail closed: every capture trigger must exist and fire in normal
    -- sessions ('O' origin or 'A' always). Checked under the locks above,
    -- which conflict with ALTER TABLE ... DISABLE TRIGGER until COMMIT, and
    -- before any sequence value, epoch or baseline row is produced.
    SELECT string_agg(e.tbl || '.' || e.trg, ', ' ORDER BY e.tbl, e.trg) INTO uncaptured
      FROM (VALUES
        ('plan_assignments', 'adherence_assignment_event', 'public.capture_adherence_assignment_event()'),
        ('plan_assignment_trainings', 'adherence_assignment_training_event', 'public.capture_adherence_assignment_event()'),
        ('trainings', 'adherence_catalog_event', 'public.capture_adherence_catalog_event()'),
        ('training_blocks', 'adherence_catalog_event', 'public.capture_adherence_catalog_event()'),
        ('training_exercises', 'adherence_catalog_event', 'public.capture_adherence_catalog_event()'),
        ('exercises', 'adherence_catalog_event', 'public.capture_adherence_catalog_event()'),
        ('training_groups', 'adherence_catalog_event', 'public.capture_adherence_catalog_event()'),
        ('diet_groups', 'adherence_catalog_event', 'public.capture_adherence_catalog_event()'),
        ('catalog_colors', 'adherence_catalog_event', 'public.capture_adherence_catalog_event()'),
        ('diets', 'adherence_catalog_event', 'public.capture_adherence_catalog_event()'),
        ('meals', 'adherence_catalog_event', 'public.capture_adherence_catalog_event()'),
        ('meal_ingredients', 'adherence_catalog_event', 'public.capture_adherence_catalog_event()'),
        ('ingredients', 'adherence_catalog_event', 'public.capture_adherence_catalog_event()'),
        ('diet_day_snapshots', 'adherence_effective_event', 'public.capture_adherence_effective_event()'),
        ('rir_day_targets', 'adherence_effective_event', 'public.capture_adherence_effective_event()'),
        ('training_day_snapshots', 'adherence_effective_event', 'public.capture_adherence_effective_event()')
      ) AS e(tbl, trg, fn)
      WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
        WHERE t.tgrelid = pg_catalog.to_regclass('public.' || e.tbl)
          AND t.tgname = e.trg
          AND t.tgfoid = pg_catalog.to_regprocedure(e.fn)
          AND NOT t.tgisinternal
          AND t.tgenabled IN ('O', 'A'));
    IF uncaptured IS NOT NULL THEN
      RAISE EXCEPTION 'History capture requires every adherence journal trigger enabled'
        USING ERRCODE = '55000', DETAIL = 'Disabled or missing: ' || uncaptured;
    END IF;
    -- FORCE RLS is compatible only when this effective invoker sees all rows.
    seq_oid := pg_catalog.pg_get_serial_sequence(
      'public.adherence_assignment_journal', 'event_sequence')::regclass;
    SELECT format('%I.%I', n.nspname, s.relname) INTO qualified_sequence
      FROM pg_catalog.pg_class s
      JOIN pg_catalog.pg_namespace n ON n.oid = s.relnamespace
      JOIN pg_catalog.pg_roles r ON r.oid = s.relowner
      WHERE s.oid = seq_oid AND s.relkind = 'S' AND r.rolname = current_user
        AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_class c
          WHERE c.oid IN ('public.adherence_assignment_journal'::regclass,
            'public.adherence_catalog_journal'::regclass,
            'public.adherence_history_epochs'::regclass,
            'public.adherence_history_baselines'::regclass,
            'public.catalog_colors'::regclass, 'public.diet_groups'::regclass,
            'public.diets'::regclass, 'public.exercises'::regclass,
            'public.ingredients'::regclass, 'public.meal_ingredients'::regclass,
            'public.meals'::regclass, 'public.plan_assignment_trainings'::regclass,
            'public.plan_assignments'::regclass, 'public.training_blocks'::regclass,
            'public.training_exercises'::regclass, 'public.training_groups'::regclass,
            'public.trainings'::regclass, 'public.diet_day_snapshots'::regclass,
            'public.rir_day_targets'::regclass, 'public.training_day_snapshots'::regclass)
            AND (c.relowner <> s.relowner OR pg_catalog.row_security_active(c.oid)))
        AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_proc f
          WHERE f.oid IN ('public.capture_adherence_assignment_event()'::regprocedure,
            'public.capture_adherence_catalog_event()'::regprocedure,
            'public.capture_adherence_effective_event()'::regprocedure)
            AND f.proowner <> s.relowner);
    IF qualified_sequence IS NULL THEN
      RAISE EXCEPTION 'History capture requires the migration/journals/sequence owner'
        USING ERRCODE = '42501';
    END IF;
    -- Optional actual metadata is diagnostic, never continuity authority.
    BEGIN
      SELECT c.system_identifier::text INTO system_identifier
        FROM pg_catalog.pg_control_system() c;
      SELECT c.timeline_id INTO timeline FROM pg_catalog.pg_control_checkpoint() c;
      SELECT d.oid::bigint INTO database_oid FROM pg_catalog.pg_database d
        WHERE d.datname = current_database();
    EXCEPTION WHEN insufficient_privilege OR undefined_function THEN
      system_identifier := NULL;
      timeline := NULL;
      database_oid := NULL;
    END;
    EXECUTE format('SELECT pg_catalog.nextval(%L::regclass)', qualified_sequence) INTO boundary;
    INSERT INTO public.adherence_history_epochs
      (source_set_version, activating_full_xid, sequence_boundary, capture_observed_at,
       source_system_identifier, source_timeline, source_database_oid)
    VALUES (1, pg_current_xact_id()::text, boundary, clock_timestamp(),
      system_identifier, timeline, database_oid) RETURNING adherence_history_epochs.id INTO new_epoch;
    FOREACH source IN ARRAY ARRAY['catalog_colors', 'diet_groups', 'diets',
      'exercises', 'ingredients', 'meal_ingredients', 'meals',
      'plan_assignment_trainings', 'plan_assignments', 'training_blocks',
      'training_exercises', 'training_groups', 'trainings'] LOOP
      EXECUTE format('INSERT INTO public.adherence_history_baselines (epoch_id, source_table, row_key, row_image) SELECT $1, $2, s.id, to_jsonb(s) FROM public.%I s', source)
        USING new_epoch, source;
    END LOOP;
    FOREACH source IN ARRAY ARRAY['diet_day_snapshots', 'rir_day_targets', 'training_day_snapshots'] LOOP
      EXECUTE format('INSERT INTO public.adherence_history_baselines(epoch_id, source_table, row_key, row_image) SELECT $1, $2, public.adherence_effective_row_key($2, to_jsonb(s)), to_jsonb(s) FROM public.%I s', source)
        USING new_epoch, source;
    END LOOP;
    INSERT INTO public.adherence_history_baselines(epoch_id, source_table, row_key, row_image)
    SELECT new_epoch, '__adherence_coverage__', 'effective-prescription-v2',
      jsonb_build_object('id', 'effective-prescription-v2', 'version', 2,
        'sources', jsonb_build_array('catalog_colors', 'diet_groups', 'diets', 'exercises', 'ingredients',
          'meal_ingredients', 'meals', 'plan_assignment_trainings', 'plan_assignments',
          'training_blocks', 'training_exercises', 'training_groups', 'trainings',
          'diet_day_snapshots', 'rir_day_targets', 'training_day_snapshots'),
        'counts', (SELECT jsonb_object_agg(s.name, (SELECT count(*) FROM public.adherence_history_baselines b
          WHERE b.epoch_id = new_epoch AND b.source_table = s.name))
          FROM unnest(ARRAY['catalog_colors', 'diet_groups', 'diets', 'exercises', 'ingredients',
            'meal_ingredients', 'meals', 'plan_assignment_trainings', 'plan_assignments',
            'training_blocks', 'training_exercises', 'training_groups', 'trainings',
            'diet_day_snapshots', 'rir_day_targets', 'training_day_snapshots']) s(name)));
    RETURN QUERY SELECT e.id, e.activating_full_xid
      FROM public.adherence_history_epochs e WHERE e.id = new_epoch;
END;
$$;
-- CREATE OR REPLACE keeps the existing ACL; restated so the intent is explicit.
REVOKE EXECUTE ON FUNCTION public.activate_adherence_history_origin() FROM PUBLIC;
COMMIT;
