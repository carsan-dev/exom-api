-- Coherent state capture only, NOT historical UTC/commit-time reconstruction.
-- Existing multi-table writers can take locks in another order: a deadlock or
-- bounded lock timeout aborts this entire transaction; retry the whole migration.
BEGIN;
SET TRANSACTION ISOLATION LEVEL READ COMMITTED;
SET LOCAL lock_timeout = '5s';

-- Alphabetical barrier: drain ALL writers before the first baseline query or
-- sequence allocation. READ COMMITTED takes fresh snapshots after that drain.
LOCK TABLE public.catalog_colors, public.diet_groups, public.diets,
    public.exercises, public.ingredients, public.meal_ingredients, public.meals,
    public.plan_assignment_trainings, public.plan_assignments,
    public.training_blocks, public.training_exercises, public.training_groups,
    public.trainings IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE public.adherence_history_epochs (
    id TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    source_set_version INTEGER NOT NULL,
    activating_full_xid TEXT NOT NULL,
    sequence_boundary BIGINT NOT NULL,
    capture_observed_at TIMESTAMPTZ(6) NOT NULL,
    source_system_identifier TEXT,
    source_timeline INTEGER,
    source_database_oid BIGINT,
    CONSTRAINT adherence_history_epochs_pkey PRIMARY KEY (id),
    CONSTRAINT adherence_history_epochs_source_version_check CHECK (source_set_version = 1),
    CONSTRAINT adherence_history_epochs_xid_check CHECK (activating_full_xid ~ '^[0-9]+$'),
    CONSTRAINT adherence_history_epochs_identity_check CHECK (
      (source_system_identifier IS NULL AND source_timeline IS NULL AND source_database_oid IS NULL) OR
      (source_system_identifier IS NOT NULL AND source_system_identifier ~ '^[0-9]+$'
       AND source_timeline IS NOT NULL AND source_timeline > 0
       AND source_database_oid IS NOT NULL AND source_database_oid > 0))
);
CREATE TABLE public.adherence_history_baselines (
    epoch_id TEXT NOT NULL,
    source_table TEXT NOT NULL,
    row_key TEXT NOT NULL,
    row_image JSONB NOT NULL,
    CONSTRAINT adherence_history_baselines_pkey PRIMARY KEY (epoch_id, source_table, row_key),
    CONSTRAINT adherence_history_baselines_epoch_fkey FOREIGN KEY (epoch_id)
      REFERENCES public.adherence_history_epochs(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT adherence_history_baselines_source_check CHECK (source_table IN (
      'catalog_colors', 'diet_groups', 'diets', 'exercises', 'ingredients',
      'meal_ingredients', 'meals', 'plan_assignment_trainings', 'plan_assignments',
      'training_blocks', 'training_exercises', 'training_groups', 'trainings')),
    CONSTRAINT adherence_history_baselines_image_check CHECK (
      jsonb_typeof(row_image) = 'object' AND row_image ? 'id'
      AND jsonb_typeof(row_image->'id') = 'string' AND row_image->>'id' = row_key)
);

DO $$
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
    -- FORCE RLS is compatible only when this effective role sees all rows.
    -- Require owner visibility on every source too: a filtered RLS policy must
    -- never silently turn a partial row set into a purported full baseline.
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
            AND (c.relowner <> s.relowner OR pg_catalog.row_security_active(c.oid)))
        AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_proc f
          WHERE f.oid IN ('public.capture_adherence_assignment_event()'::regprocedure,
            'public.capture_adherence_catalog_event()'::regprocedure)
            AND f.proowner <> s.relowner);
    IF qualified_sequence IS NULL THEN
      RAISE EXCEPTION 'History capture requires the migration/journals/sequence owner'
        USING ERRCODE = '42501';
    END IF;

    -- Optional REAL source metadata; no privilege changes and no fabricated
    -- incarnation nonce. Even these values cannot alone prove continuity after
    -- a physical restore/fork: a future resolver must validate its namespace.
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
      system_identifier, timeline, database_oid) RETURNING id INTO epoch_id;

    -- One server-side INSERT SELECT per source: no aggregate JSON, application
    -- fan-out, or timestamp inference. Existing journals remain untouched.
    FOREACH source IN ARRAY ARRAY['catalog_colors', 'diet_groups', 'diets',
      'exercises', 'ingredients', 'meal_ingredients', 'meals',
      'plan_assignment_trainings', 'plan_assignments', 'training_blocks',
      'training_exercises', 'training_groups', 'trainings'] LOOP
      EXECUTE format('INSERT INTO public.adherence_history_baselines (epoch_id, source_table, row_key, row_image) SELECT $1, $2, s.id, to_jsonb(s) FROM public.%I s', source)
        USING epoch_id, source;
    END LOOP;
END;
$$;

COMMENT ON COLUMN public.adherence_history_epochs.capture_observed_at IS
    'Observation only, NOT commit time, a known UTC cutoff, or prior historical proof.';
COMMENT ON COLUMN public.adherence_history_epochs.activating_full_xid IS
    'Full xid8 text; durable commit resolution pending. Missing/aliased restore namespace is UNKNOWN.';
COMMENT ON COLUMN public.adherence_history_epochs.sequence_boundary IS
    'Shared allocator boundary after all 13 writer barriers; gaps normal, NOT commit order.';
COMMENT ON TABLE public.adherence_history_baselines IS
    'Private full source row images; future projections must sanitize URLs and identity references.';

CREATE FUNCTION public.reject_adherence_history_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    RAISE EXCEPTION 'Adherence history is append-only' USING ERRCODE = '55000';
END;
$$;
REVOKE EXECUTE ON FUNCTION public.reject_adherence_history_mutation() FROM PUBLIC;
CREATE TRIGGER adherence_history_epochs_append_only
    BEFORE UPDATE OR DELETE OR TRUNCATE ON public.adherence_history_epochs
    FOR EACH STATEMENT EXECUTE FUNCTION public.reject_adherence_history_mutation();
CREATE TRIGGER adherence_history_baselines_append_only
    BEFORE UPDATE OR DELETE OR TRUNCATE ON public.adherence_history_baselines
    FOR EACH STATEMENT EXECUTE FUNCTION public.reject_adherence_history_mutation();
REVOKE ALL ON public.adherence_history_epochs, public.adherence_history_baselines FROM PUBLIC;
ALTER TABLE public.adherence_history_epochs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.adherence_history_baselines ENABLE ROW LEVEL SECURITY;
COMMIT;
