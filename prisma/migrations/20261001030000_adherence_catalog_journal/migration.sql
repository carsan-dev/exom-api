-- Producer only: existing rows are NOT bootstrapped; pre-capture history is UNKNOWN.
-- Allocation/observation is not commit order/time, UTC closure or historical proof.
-- Full catalog images may include upload references: future readers must sanitize them.
BEGIN;

-- Hold all source locks through installation; no partially installed capture set.
LOCK TABLE public.trainings, public.training_blocks, public.training_exercises,
    public.exercises, public.training_groups, public.diet_groups,
    public.catalog_colors, public.diets, public.meals, public.meal_ingredients,
    public.ingredients IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE public.adherence_catalog_journal (
    event_sequence BIGINT NOT NULL,
    transaction_id TEXT NOT NULL DEFAULT pg_current_xact_id()::text,
    source_table TEXT NOT NULL,
    operation TEXT NOT NULL,
    old_row JSONB,
    new_row JSONB,
    observed_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT adherence_catalog_journal_pkey PRIMARY KEY (event_sequence),
    CONSTRAINT adherence_catalog_journal_source_check CHECK (source_table IN (
      'trainings', 'training_blocks', 'training_exercises', 'exercises',
      'training_groups', 'diet_groups', 'catalog_colors', 'diets', 'meals',
      'meal_ingredients', 'ingredients')),
    CONSTRAINT adherence_catalog_journal_transaction_check CHECK (transaction_id ~ '^[0-9]+$'),
    CONSTRAINT adherence_catalog_journal_shape_check CHECK (
      (operation = 'INSERT' AND old_row IS NULL AND new_row IS NOT NULL) OR
      (operation = 'UPDATE' AND old_row IS NOT NULL AND new_row IS NOT NULL) OR
      (operation = 'DELETE' AND old_row IS NOT NULL AND new_row IS NULL)),
    CONSTRAINT adherence_catalog_journal_images_check CHECK (
      (old_row IS NULL OR (jsonb_typeof(old_row) = 'object' AND
        old_row ? 'id' AND jsonb_typeof(old_row->'id') = 'string')) AND
      (new_row IS NULL OR (jsonb_typeof(new_row) = 'object' AND
        new_row ? 'id' AND jsonb_typeof(new_row->'id') = 'string')))
);

-- Share assignment allocation order without assuming the sequence's name.
-- Fail closed if migration actor, existing capture, journal or sequence owners differ.
DO $$
DECLARE seq_oid regclass;
DECLARE qualified_sequence text;
BEGIN
    seq_oid := pg_catalog.pg_get_serial_sequence(
      'public.adherence_assignment_journal', 'event_sequence')::regclass;
    SELECT format('%I.%I', n.nspname, s.relname) INTO qualified_sequence
      FROM pg_catalog.pg_class s JOIN pg_catalog.pg_namespace n ON n.oid = s.relnamespace
      JOIN pg_catalog.pg_roles r ON r.oid = s.relowner
      JOIN pg_catalog.pg_class a ON a.oid = 'public.adherence_assignment_journal'::regclass
      JOIN pg_catalog.pg_class c ON c.oid = 'public.adherence_catalog_journal'::regclass
      JOIN pg_catalog.pg_proc f ON f.oid = 'public.capture_adherence_assignment_event()'::regprocedure
      WHERE s.oid = seq_oid AND s.relkind = 'S' AND r.rolname = current_user
        AND a.relowner = s.relowner AND c.relowner = s.relowner
        AND f.proowner = s.relowner AND NOT a.relforcerowsecurity;
    IF qualified_sequence IS NULL THEN
      RAISE EXCEPTION 'Catalog capture requires the migration/journal/sequence owner'
        USING ERRCODE = '42501';
    END IF;
    EXECUTE format('ALTER TABLE public.adherence_catalog_journal ALTER COLUMN event_sequence SET DEFAULT nextval(%L::regclass)', qualified_sequence);
END;
$$;
CREATE INDEX adherence_catalog_journal_transaction_id_event_sequence_idx
    ON public.adherence_catalog_journal(transaction_id, event_sequence);
COMMENT ON COLUMN public.adherence_catalog_journal.event_sequence IS
    'Global assignment/catalog row allocation order; gaps normal, NOT cross-transaction commit order.';
COMMENT ON COLUMN public.adherence_catalog_journal.transaction_id IS
    'Full xid8 text; NOT commit metadata. Missing commit evidence remains UNKNOWN.';
COMMENT ON COLUMN public.adherence_catalog_journal.observed_at IS
    'Mutation observation only, NOT commit time or UTC day closure proof.';

CREATE FUNCTION public.capture_adherence_catalog_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
    IF TG_TABLE_SCHEMA <> 'public' OR TG_LEVEL <> 'ROW' OR TG_WHEN <> 'AFTER'
       OR TG_OP NOT IN ('INSERT', 'UPDATE', 'DELETE')
       OR NOT (
         (TG_TABLE_NAME = 'trainings' AND TG_RELID = 'public.trainings'::regclass) OR
         (TG_TABLE_NAME = 'training_blocks' AND TG_RELID = 'public.training_blocks'::regclass) OR
         (TG_TABLE_NAME = 'training_exercises' AND TG_RELID = 'public.training_exercises'::regclass) OR
         (TG_TABLE_NAME = 'exercises' AND TG_RELID = 'public.exercises'::regclass) OR
         (TG_TABLE_NAME = 'training_groups' AND TG_RELID = 'public.training_groups'::regclass) OR
         (TG_TABLE_NAME = 'diet_groups' AND TG_RELID = 'public.diet_groups'::regclass) OR
         (TG_TABLE_NAME = 'catalog_colors' AND TG_RELID = 'public.catalog_colors'::regclass) OR
         (TG_TABLE_NAME = 'diets' AND TG_RELID = 'public.diets'::regclass) OR
         (TG_TABLE_NAME = 'meals' AND TG_RELID = 'public.meals'::regclass) OR
         (TG_TABLE_NAME = 'meal_ingredients' AND TG_RELID = 'public.meal_ingredients'::regclass) OR
         (TG_TABLE_NAME = 'ingredients' AND TG_RELID = 'public.ingredients'::regclass)
       ) THEN
      RAISE EXCEPTION 'Untrusted adherence catalog capture trigger context' USING ERRCODE = '42501';
    END IF;
    INSERT INTO public.adherence_catalog_journal
      (transaction_id, source_table, operation, old_row, new_row)
    VALUES (pg_current_xact_id()::text, TG_TABLE_NAME, TG_OP,
      CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) ELSE NULL END,
      CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) ELSE NULL END);
    RETURN NULL;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.capture_adherence_catalog_event() FROM PUBLIC;
DO $$
DECLARE source text;
BEGIN
    FOREACH source IN ARRAY ARRAY['trainings', 'training_blocks', 'training_exercises',
      'exercises', 'training_groups', 'diet_groups', 'catalog_colors', 'diets',
      'meals', 'meal_ingredients', 'ingredients'] LOOP
      EXECUTE format('CREATE TRIGGER adherence_catalog_event AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.capture_adherence_catalog_event()', source);
    END LOOP;
END;
$$;

-- Ordinary DML only; owner/superuser DDL or disabled triggers are not defended.
CREATE FUNCTION public.reject_adherence_catalog_journal_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    RAISE EXCEPTION 'Adherence catalog journal is append-only' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER adherence_catalog_journal_append_only
    BEFORE UPDATE OR DELETE OR TRUNCATE ON public.adherence_catalog_journal
    FOR EACH STATEMENT EXECUTE FUNCTION public.reject_adherence_catalog_journal_mutation();
REVOKE ALL ON public.adherence_catalog_journal FROM PUBLIC;
ALTER TABLE public.adherence_catalog_journal ENABLE ROW LEVEL SECURITY;
COMMIT;
