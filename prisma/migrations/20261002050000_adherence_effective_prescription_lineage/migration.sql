-- Additive effective-reader lineage. Original epoch/proof/cut bytes are untouched.
-- New16 coverage lives in one immutable baseline marker, bound by the existing86
-- baseline digest. Presence at activation is proven, NOT legacy captured_at.
BEGIN;
SET LOCAL lock_timeout = '5s';
-- Common13 first, then the three overlays in deterministic alphabetical order.
-- Existing multi-table writers may cycle: timeout/abort requires whole retry.
LOCK TABLE public.catalog_colors, public.diet_groups, public.diets,
  public.exercises, public.ingredients, public.meal_ingredients, public.meals,
  public.plan_assignment_trainings, public.plan_assignments,
  public.training_blocks, public.training_exercises, public.training_groups,
  public.trainings, public.diet_day_snapshots, public.rir_day_targets,
  public.training_day_snapshots IN SHARE ROW EXCLUSIVE MODE;

CREATE FUNCTION public.adherence_effective_row_key(source text, image jsonb)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT CASE WHEN source IN ('diet_day_snapshots', 'training_day_snapshots', 'rir_day_targets') THEN
    CASE WHEN jsonb_typeof(image->'client_id') = 'string' AND jsonb_typeof(image->'date') = 'string'
      AND jsonb_typeof(image->(CASE source WHEN 'diet_day_snapshots' THEN 'diet_id'
        WHEN 'training_day_snapshots' THEN 'training_id' ELSE 'training_exercise_id' END)) = 'string'
      THEN jsonb_build_array(image->>'client_id', image->>'date', image->>(CASE source
        WHEN 'diet_day_snapshots' THEN 'diet_id' WHEN 'training_day_snapshots' THEN 'training_id'
        ELSE 'training_exercise_id' END))::text ELSE NULL END
    ELSE CASE WHEN jsonb_typeof(image->'id') = 'string' THEN image->>'id' ELSE NULL END END;
$$;
REVOKE EXECUTE ON FUNCTION public.adherence_effective_row_key(text, jsonb) FROM PUBLIC;

ALTER TABLE public.adherence_catalog_journal DROP CONSTRAINT adherence_catalog_journal_source_check;
ALTER TABLE public.adherence_catalog_journal ADD CONSTRAINT adherence_catalog_journal_source_check CHECK (source_table IN (
  'trainings', 'training_blocks', 'training_exercises', 'exercises',
  'training_groups', 'diet_groups', 'catalog_colors', 'diets', 'meals',
  'meal_ingredients', 'ingredients', 'diet_day_snapshots', 'rir_day_targets', 'training_day_snapshots'));
ALTER TABLE public.adherence_catalog_journal DROP CONSTRAINT adherence_catalog_journal_images_check;
ALTER TABLE public.adherence_catalog_journal ADD CONSTRAINT adherence_catalog_journal_images_check CHECK (
  (old_row IS NULL OR (jsonb_typeof(old_row) = 'object' AND
    public.adherence_effective_row_key(source_table, old_row) IS NOT NULL)) AND
  (new_row IS NULL OR (jsonb_typeof(new_row) = 'object' AND
    public.adherence_effective_row_key(source_table, new_row) IS NOT NULL)));
ALTER TABLE public.adherence_history_baselines DROP CONSTRAINT adherence_history_baselines_source_check;
ALTER TABLE public.adherence_history_baselines ADD CONSTRAINT adherence_history_baselines_source_check CHECK (source_table IN (
  'catalog_colors', 'diet_groups', 'diets', 'exercises', 'ingredients',
  'meal_ingredients', 'meals', 'plan_assignment_trainings', 'plan_assignments',
  'training_blocks', 'training_exercises', 'training_groups', 'trainings',
  'diet_day_snapshots', 'rir_day_targets', 'training_day_snapshots', '__adherence_coverage__'));
ALTER TABLE public.adherence_history_baselines DROP CONSTRAINT adherence_history_baselines_image_check;
ALTER TABLE public.adherence_history_baselines ADD CONSTRAINT adherence_history_baselines_image_check CHECK (
  jsonb_typeof(row_image) = 'object' AND public.adherence_effective_row_key(source_table, row_image) IS NOT NULL
  AND row_key = public.adherence_effective_row_key(source_table, row_image)
  AND (source_table <> '__adherence_coverage__' OR row_key = 'effective-prescription-v2'));

-- Legitimate nonowner source INSERT/UPDATE/cascade writers must not receive
-- journal or allocator privileges. Only these exact OIDs can enter this definer.
CREATE FUNCTION public.capture_adherence_effective_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF TG_TABLE_SCHEMA <> 'public' OR TG_LEVEL <> 'ROW' OR TG_WHEN <> 'AFTER'
    OR TG_OP NOT IN ('INSERT', 'UPDATE', 'DELETE') OR TG_NARGS <> 0
    OR NOT ((TG_TABLE_NAME = 'diet_day_snapshots' AND TG_RELID = 'public.diet_day_snapshots'::regclass)
      OR (TG_TABLE_NAME = 'rir_day_targets' AND TG_RELID = 'public.rir_day_targets'::regclass)
      OR (TG_TABLE_NAME = 'training_day_snapshots' AND TG_RELID = 'public.training_day_snapshots'::regclass))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      WHERE c.oid IN (TG_RELID, 'public.adherence_catalog_journal'::regclass)
      AND (c.relowner <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user) OR c.relforcerowsecurity)) THEN
    RAISE EXCEPTION 'Untrusted effective capture context' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.adherence_catalog_journal(transaction_id, source_table, operation, old_row, new_row)
  VALUES (pg_current_xact_id()::text, TG_TABLE_NAME, TG_OP,
    CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) ELSE NULL END,
    CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) ELSE NULL END);
  RETURN NULL;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.capture_adherence_effective_event() FROM PUBLIC;
DO $$ DECLARE source text;
BEGIN
  PERFORM public.assert_adherence_commit_owner();
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c
    WHERE c.oid IN ('public.diet_day_snapshots'::regclass, 'public.rir_day_targets'::regclass,
      'public.training_day_snapshots'::regclass,
      pg_get_serial_sequence('public.adherence_assignment_journal', 'event_sequence')::regclass)
    AND (c.relowner <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user) OR c.relforcerowsecurity)) THEN
    RAISE EXCEPTION 'Effective capture requires migration/source/allocator owner' USING ERRCODE = '42501';
  END IF;
  FOREACH source IN ARRAY ARRAY['diet_day_snapshots', 'rir_day_targets', 'training_day_snapshots'] LOOP
    EXECUTE format('CREATE TRIGGER adherence_effective_event AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.capture_adherence_effective_event()', source);
  END LOOP;
END;
$$;

-- Structural validation is only coverage identity. The source/publisher must
-- ALSO validate the original cut, whose activation proof hashes this marker.
CREATE FUNCTION public.adherence_has_effective_coverage(p_epoch text)
RETURNS boolean LANGUAGE sql SET search_path = pg_catalog AS $$
  SELECT EXISTS (SELECT 1 FROM public.adherence_history_baselines b
    WHERE b.epoch_id = p_epoch AND b.source_table = '__adherence_coverage__'
      AND b.row_key = 'effective-prescription-v2'
      AND b.row_image = jsonb_build_object('id', 'effective-prescription-v2', 'version', 2,
        'sources', jsonb_build_array('catalog_colors', 'diet_groups', 'diets', 'exercises', 'ingredients',
          'meal_ingredients', 'meals', 'plan_assignment_trainings', 'plan_assignments',
          'training_blocks', 'training_exercises', 'training_groups', 'trainings',
          'diet_day_snapshots', 'rir_day_targets', 'training_day_snapshots'),
        'counts', (SELECT jsonb_object_agg(s.name, (SELECT count(*) FROM public.adherence_history_baselines c
          WHERE c.epoch_id = p_epoch AND c.source_table = s.name))
          FROM unnest(ARRAY['catalog_colors', 'diet_groups', 'diets', 'exercises', 'ingredients',
            'meal_ingredients', 'meals', 'plan_assignment_trainings', 'plan_assignments',
            'training_blocks', 'training_exercises', 'training_groups', 'trainings',
            'diet_day_snapshots', 'rir_day_targets', 'training_day_snapshots']) s(name))));
$$;
REVOKE EXECUTE ON FUNCTION public.adherence_has_effective_coverage(text) FROM PUBLIC;

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
            AND (c.relowner <> s.relowner OR c.relforcerowsecurity))
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
REVOKE EXECUTE ON FUNCTION public.activate_adherence_history_origin() FROM PUBLIC;
COMMENT ON FUNCTION public.activate_adherence_history_origin() IS
  'Owner-only invoker fresh epoch; trusted owner must avoid privileged maintenance while a process-local uninterrupted backend lease is active. No restored epoch adoption or universal continuity claim.';

CREATE OR REPLACE FUNCTION public.begin_adherence_history_cut(p_epoch text, p_cutoff text, p_max integer)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE seq_name text; boundary bigint; ids jsonb; now_utc timestamptz;
BEGIN
    PERFORM public.assert_adherence_cut_owner();
    IF current_setting('transaction_isolation') <> 'read committed' THEN
      RAISE EXCEPTION 'Cut requires fresh READ COMMITTED statements' USING ERRCODE = '25001';
    END IF;
    IF p_cutoff IS NULL OR p_cutoff !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$'
      OR p_max IS NULL OR p_max NOT BETWEEN 1 AND 128 THEN RETURN NULL; END IF;
    PERFORM set_config('lock_timeout', '2s', true);
    -- EXACT85/87 order. These locks survive enumeration AND manifest COMMIT.
    LOCK TABLE public.catalog_colors, public.diet_groups, public.diets,
      public.exercises, public.ingredients, public.meal_ingredients, public.meals,
      public.plan_assignment_trainings, public.plan_assignments,
      public.training_blocks, public.training_exercises, public.training_groups,
      public.trainings, public.diet_day_snapshots, public.rir_day_targets,
      public.training_day_snapshots IN SHARE ROW EXCLUSIVE MODE;
    -- Fresh statement snapshot after draining writers. Not transaction_timestamp.
    now_utc := clock_timestamp();
    IF now_utc < p_cutoff::timestamptz THEN RETURN NULL; END IF;
    seq_name := pg_get_serial_sequence('public.adherence_assignment_journal', 'event_sequence');
    EXECUTE format('SELECT pg_catalog.nextval(%L::regclass)', seq_name) INTO boundary;
    ids := public.adherence_cut_universe(p_epoch, boundary, p_max);
    IF ids IS NULL THEN RETURN NULL; END IF;
    RETURN jsonb_build_object('barrier_boundary', boundary::text, 'full_xids', ids);
END;
$$;


CREATE OR REPLACE FUNCTION public.issue_adherence_history_cut(p_epoch text, p_origin text, p_cutoff text, p_barrier bigint)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE payload jsonb; stored jsonb;
BEGIN
    PERFORM public.assert_adherence_cut_owner();
    IF (SELECT count(*) FROM pg_catalog.pg_locks l WHERE l.pid = pg_backend_pid()
      AND l.locktype = 'relation' AND l.mode = 'ShareRowExclusiveLock' AND l.granted
      AND l.relation = ANY(ARRAY['public.catalog_colors'::regclass, 'public.diet_groups'::regclass,
        'public.diets'::regclass, 'public.exercises'::regclass, 'public.ingredients'::regclass,
        'public.meal_ingredients'::regclass, 'public.meals'::regclass,
        'public.plan_assignment_trainings'::regclass, 'public.plan_assignments'::regclass,
        'public.training_blocks'::regclass, 'public.training_exercises'::regclass,
        'public.training_groups'::regclass, 'public.trainings'::regclass])) <> 13 THEN
      RAISE EXCEPTION 'Cut source barrier not held' USING ERRCODE = '25001';
    END IF;
    IF public.adherence_has_effective_coverage(p_epoch) AND
      (SELECT count(*) FROM pg_catalog.pg_locks l WHERE l.pid = pg_backend_pid()
        AND l.locktype = 'relation' AND l.mode = 'ShareRowExclusiveLock' AND l.granted
        AND l.relation = ANY(ARRAY['public.diet_day_snapshots'::regclass,
          'public.rir_day_targets'::regclass, 'public.training_day_snapshots'::regclass])) <> 3 THEN
      RAISE EXCEPTION 'Effective cut source barrier not held' USING ERRCODE = '25001';
    END IF;
    payload := public.adherence_cut_payload(p_epoch, p_origin, p_cutoff, p_barrier);
    IF payload IS NULL THEN RAISE EXCEPTION 'Incomplete cut' USING ERRCODE = '22000'; END IF;
    INSERT INTO public.adherence_history_cuts(epoch_id, origin, cutoff_utc, manifest)
      VALUES (p_epoch, p_origin, p_cutoff, payload) ON CONFLICT DO NOTHING;
    SELECT manifest INTO stored FROM public.adherence_history_cuts
      WHERE epoch_id = p_epoch AND origin = p_origin AND cutoff_utc = p_cutoff;
    IF stored IS DISTINCT FROM payload THEN RAISE EXCEPTION 'Discordant immutable cut retry' USING ERRCODE = '22000'; END IF;
    RETURN public.read_adherence_history_cut(p_epoch, p_origin, p_cutoff);
END;
$$;

CREATE OR REPLACE FUNCTION public.adherence_prescription_source(p_epoch text, p_origin text, p_cutoff text)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog SET TimeZone = 'UTC' SET DateStyle = 'ISO, YMD' AS $$
DECLARE cut jsonb; manifest jsonb; baseline jsonb; events jsonb;
BEGIN
  PERFORM public.assert_adherence_prescription_owner();
  cut := public.read_adherence_history_cut(p_epoch, p_origin, p_cutoff);
  IF cut->>'state' IS DISTINCT FROM 'cut' OR clock_timestamp() < p_cutoff::timestamptz
    OR NOT EXISTS (SELECT 1 FROM public.adherence_history_epochs WHERE id = p_epoch AND source_set_version = 1) THEN
    RETURN jsonb_build_object('state', 'unknown');
  END IF;
  manifest := cut->'manifest';
  SELECT coalesce(jsonb_agg(jsonb_build_object('source_table', b.source_table,
    'row_key', b.row_key, 'row_image', b.row_image) ORDER BY b.source_table, b.row_key), '[]'::jsonb)
    INTO baseline FROM public.adherence_history_baselines b WHERE b.epoch_id = p_epoch;
  SELECT coalesce(jsonb_agg(j.image ORDER BY j.seq), '[]'::jsonb) INTO events FROM (
    SELECT a.event_sequence seq, to_jsonb(a) || jsonb_build_object('event_sequence', a.event_sequence::text) image
      FROM public.adherence_assignment_journal a
      WHERE a.event_sequence > (manifest->>'epoch_boundary')::bigint AND a.event_sequence <= (manifest->>'barrier_boundary')::bigint
    UNION ALL
    SELECT c.event_sequence, to_jsonb(c) || jsonb_build_object('event_sequence', c.event_sequence::text)
      FROM public.adherence_catalog_journal c
      WHERE c.event_sequence > (manifest->>'epoch_boundary')::bigint AND c.event_sequence <= (manifest->>'barrier_boundary')::bigint
  ) j;
  RETURN jsonb_build_object('state', 'source', 'manifest', manifest, 'baseline', baseline, 'events', events);
END;
$$;


CREATE OR REPLACE FUNCTION public.publish_adherence_prescription(p_client text, p_date date,
  p_epoch text, p_origin text, p_cutoff text, p_prescription jsonb, p_manifest_digest text)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog SET TimeZone = 'UTC' SET DateStyle = 'ISO, YMD' AS $$
DECLARE cut jsonb; binding jsonb; payload jsonb; stored jsonb; covered boolean;
BEGIN
  PERFORM public.assert_adherence_prescription_owner();
  covered := public.adherence_has_effective_coverage(p_epoch);
  IF p_client IS NULL OR length(p_client) = 0 OR p_date IS NULL
    OR p_cutoff IS DISTINCT FROM to_char(p_date + interval '1 day', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    OR clock_timestamp() < p_cutoff::timestamptz
    OR p_prescription->>'client_id' IS DISTINCT FROM p_client
    OR p_prescription->>'date' IS DISTINCT FROM p_date::text
    OR p_prescription->>'version' IS DISTINCT FROM '1'
    OR p_prescription->'training'->>'membership_basis' IS DISTINCT FROM 'known'
    OR p_prescription->'training' ? 'basis'
    OR jsonb_typeof(p_prescription->'training'->'units') IS DISTINCT FROM 'array'
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE
      WHEN jsonb_typeof(p_prescription->'training'->'units') = 'array'
      THEN p_prescription->'training'->'units' ELSE '[]'::jsonb END) u
      WHERE (NOT covered AND (u->'effective_content'->>'basis' IS DISTINCT FROM 'unknown'
        OR u->'effective_content'->>'reason' IS DISTINCT FROM 'unproven_original_training_snapshot_and_rir_targets'
        OR u->'effective_rir'->>'basis' IS DISTINCT FROM 'unknown'
        OR u->'effective_rir'->>'reason' IS DISTINCT FROM 'unproven_original_rir_day_targets'
        )) OR (covered AND (u->'effective_content'->>'basis' IS DISTINCT FROM 'known'
        OR jsonb_typeof(u->'effective_content'->'training') IS DISTINCT FROM 'object'
        OR u->'effective_rir'->>'basis' IS DISTINCT FROM 'known'))
        OR u->'catalog_projection'->'authoritative' IS DISTINCT FROM 'false'::jsonb
        OR u ? 'training')
    OR (NOT covered AND p_prescription->'nutrition'->>'diet_id' IS NOT NULL
      AND (p_prescription->'nutrition'->>'basis' IS DISTINCT FROM 'unknown'
        OR p_prescription->'nutrition'->>'reason' IS DISTINCT FROM 'unproven_original_diet_snapshot_precedence'))
    OR coalesce(p_prescription->'nutrition'->>'basis' NOT IN ('known', 'unknown'), true) THEN
    RAISE EXCEPTION 'Invalid closed prescription binding' USING ERRCODE = '22000';
  END IF;
  cut := public.read_adherence_history_cut(p_epoch, p_origin, p_cutoff);
  IF cut->>'state' IS DISTINCT FROM 'cut' OR cut->'manifest'->>'manifest_digest' IS DISTINCT FROM p_manifest_digest THEN
    RAISE EXCEPTION 'Invalid original cut' USING ERRCODE = '22000';
  END IF;
  binding := jsonb_build_object('prescription', p_prescription,
    'provenance', jsonb_build_object('epochId', p_epoch, 'origin', p_origin, 'cutoffUtc', p_cutoff),
    'manifest_digest', p_manifest_digest);
  payload := binding || jsonb_build_object('digest', encode(sha256(convert_to(binding::text, 'UTF8')), 'hex'));
  INSERT INTO public.adherence_historical_prescriptions(client_id, date, payload)
    VALUES (p_client, p_date, payload) ON CONFLICT DO NOTHING;
  SELECT h.payload INTO stored FROM public.adherence_historical_prescriptions h WHERE h.client_id = p_client AND h.date = p_date;
  IF stored IS DISTINCT FROM payload THEN
    RAISE EXCEPTION 'Discordant immutable prescription replay' USING ERRCODE = '22000';
  END IF;
  RETURN stored;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.activate_adherence_history_origin() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.begin_adherence_history_cut(text, text, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.issue_adherence_history_cut(text, text, text, bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.adherence_prescription_source(text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.publish_adherence_prescription(text, date, text, text, text, jsonb, text) FROM PUBLIC;
COMMIT;
