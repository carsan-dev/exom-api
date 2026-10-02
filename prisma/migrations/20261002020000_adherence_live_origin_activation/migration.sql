-- Fresh owner-controlled capture only. This function does not mint an origin
-- capability: the dedicated process must receive positive COMMIT acknowledgement.
BEGIN;
CREATE FUNCTION public.activate_adherence_history_origin()
RETURNS TABLE(id text, activating_full_xid text)
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
    seq_oid regclass;
    qualified_sequence text;
    epoch_id text;
    boundary bigint;
    source text;
    system_identifier text;
    timeline integer;
    database_oid bigint;
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
      public.trainings IN SHARE ROW EXCLUSIVE MODE;
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
            'public.trainings'::regclass)
            AND (c.relowner <> s.relowner OR c.relforcerowsecurity))
        AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_proc f
          WHERE f.oid IN ('public.capture_adherence_assignment_event()'::regprocedure,
            'public.capture_adherence_catalog_event()'::regprocedure)
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
      system_identifier, timeline, database_oid) RETURNING adherence_history_epochs.id INTO epoch_id;
    FOREACH source IN ARRAY ARRAY['catalog_colors', 'diet_groups', 'diets',
      'exercises', 'ingredients', 'meal_ingredients', 'meals',
      'plan_assignment_trainings', 'plan_assignments', 'training_blocks',
      'training_exercises', 'training_groups', 'trainings'] LOOP
      EXECUTE format('INSERT INTO public.adherence_history_baselines (epoch_id, source_table, row_key, row_image) SELECT $1, $2, s.id, to_jsonb(s) FROM public.%I s', source)
        USING epoch_id, source;
    END LOOP;
    RETURN QUERY SELECT e.id, e.activating_full_xid
      FROM public.adherence_history_epochs e WHERE e.id = epoch_id;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.activate_adherence_history_origin() FROM PUBLIC;
COMMENT ON FUNCTION public.activate_adherence_history_origin() IS
  'Owner-only invoker fresh epoch; trusted owner must avoid privileged maintenance while a process-local uninterrupted backend lease is active. No restored epoch adoption or universal continuity claim.';
COMMIT;
