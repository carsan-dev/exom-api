-- Row-event foundation only. No bootstrap, catalog payload coverage, epoch,
-- commit resolution, UTC cutoff, evaluator, projection or retention is implied.
-- Reconstruct pretransaction state by reversing ALL events of the transaction;
-- BEFORE-row membership snapshots are incomplete during bulk/cascade mutations.
BEGIN;

CREATE TABLE public.adherence_assignment_journal (
    event_sequence BIGSERIAL NOT NULL,
    transaction_id TEXT NOT NULL DEFAULT pg_current_xact_id()::text,
    source_table TEXT NOT NULL,
    operation TEXT NOT NULL,
    old_row JSONB,
    new_row JSONB,
    observed_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT adherence_assignment_journal_pkey PRIMARY KEY (event_sequence),
    CONSTRAINT adherence_assignment_journal_source_check CHECK (
      source_table IN ('plan_assignments', 'plan_assignment_trainings')),
    CONSTRAINT adherence_assignment_journal_transaction_check CHECK (
      transaction_id ~ '^[0-9]+$'),
    CONSTRAINT adherence_assignment_journal_shape_check CHECK (
      (operation = 'INSERT' AND old_row IS NULL AND new_row IS NOT NULL) OR
      (operation = 'UPDATE' AND old_row IS NOT NULL AND new_row IS NOT NULL) OR
      (operation = 'DELETE' AND old_row IS NOT NULL AND new_row IS NULL)),
    CONSTRAINT adherence_assignment_journal_images_check CHECK (
      (old_row IS NULL OR (jsonb_typeof(old_row) = 'object' AND
        old_row ? 'id' AND jsonb_typeof(old_row->'id') = 'string')) AND
      (new_row IS NULL OR (jsonb_typeof(new_row) = 'object' AND
        new_row ? 'id' AND jsonb_typeof(new_row->'id') = 'string')))
);
CREATE INDEX adherence_assignment_journal_transaction_id_event_sequence_idx
    ON public.adherence_assignment_journal(transaction_id, event_sequence);
COMMENT ON COLUMN public.adherence_assignment_journal.transaction_id IS
    'Full xid8 rendered as text, not a wrapping xid32 or commit-order marker.';
COMMENT ON COLUMN public.adherence_assignment_journal.event_sequence IS
    'Row-event allocation order; gaps are normal and cross-transaction commit order is not implied.';
COMMENT ON COLUMN public.adherence_assignment_journal.observed_at IS
    'Wall-clock observation inside mutation transaction; NOT a commit timestamp or UTC day closure proof.';

CREATE FUNCTION public.capture_adherence_assignment_event() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    INSERT INTO public.adherence_assignment_journal
      (transaction_id, source_table, operation, old_row, new_row)
    VALUES (pg_current_xact_id()::text, TG_TABLE_NAME, TG_OP,
      CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) ELSE NULL END,
      CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) ELSE NULL END);
    RETURN NULL;
END;
$$;
CREATE TRIGGER adherence_assignment_event
    AFTER INSERT OR UPDATE OR DELETE ON public.plan_assignments
    FOR EACH ROW EXECUTE FUNCTION public.capture_adherence_assignment_event();
CREATE TRIGGER adherence_assignment_training_event
    AFTER INSERT OR UPDATE OR DELETE ON public.plan_assignment_trainings
    FOR EACH ROW EXECUTE FUNCTION public.capture_adherence_assignment_event();

-- Ordinary DML is append-only. This does NOT protect against an owner/superuser
-- disabling triggers or changing DDL. Role/deployment hardening is separate.
CREATE FUNCTION public.reject_adherence_assignment_journal_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    RAISE EXCEPTION 'Adherence assignment journal is append-only'
      USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER adherence_assignment_journal_append_only
    BEFORE UPDATE OR DELETE OR TRUNCATE ON public.adherence_assignment_journal
    FOR EACH STATEMENT EXECUTE FUNCTION public.reject_adherence_assignment_journal_mutation();
REVOKE ALL ON public.adherence_assignment_journal FROM PUBLIC;
ALTER TABLE public.adherence_assignment_journal ENABLE ROW LEVEL SECURITY;

COMMIT;
