-- Application-role SELECT/INSERT only; no journal, baseline or publisher grants.
-- Deployment grants those two privileges explicitly to its runtime role.
BEGIN;
CREATE TABLE public.adherence_evaluation_revisions (
  client_id text NOT NULL,
  date date NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  idempotency_key text NOT NULL,
  original_basis_id text,
  original_basis_digest text NOT NULL,
  cut_binding text,
  config_revision_id text,
  config_digest text NOT NULL,
  evidence_digest text NOT NULL,
  evaluation jsonb NOT NULL,
  created_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (client_id, date, revision),
  UNIQUE (client_id, date, idempotency_key),
  CHECK (evaluation->>'date' = date::text),
  CHECK ((evaluation->>'revision')::integer = revision),
  CHECK (evaluation->'evaluation'->>'period' = 'closed')
);
REVOKE ALL ON public.adherence_evaluation_revisions FROM PUBLIC;
CREATE TRIGGER adherence_evaluations_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON public.adherence_evaluation_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_adherence_history_mutation();
COMMIT;
