-- Restricted application writers retain only their existing source permissions.
-- The definer must be the migration/journal owner, not a business application role.
-- Ownership supplies journal RLS access (unless FORCE RLS is enabled); deployments
-- must retain that access or supply a legitimate owner policy, never blanket BYPASSRLS.
BEGIN;

DO $$
BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc f
      JOIN pg_catalog.pg_class j ON j.oid = 'public.adherence_assignment_journal'::regclass
      JOIN pg_catalog.pg_roles r ON r.oid = f.proowner
      WHERE f.oid = 'public.capture_adherence_assignment_event()'::regprocedure
        AND f.proowner = j.relowner AND r.rolname = current_user
        AND NOT j.relforcerowsecurity
    ) THEN
      RAISE EXCEPTION 'Journal capture requires the existing migration/journal owner and owner RLS access'
        USING ERRCODE = '42501';
    END IF;
END;
$$;

-- CREATE OR REPLACE preserves the installed owner and ACL. No runtime role or
-- credential is created, and no source/journal/sequence privilege is granted.
CREATE OR REPLACE FUNCTION public.capture_adherence_assignment_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
    IF TG_TABLE_SCHEMA <> 'public' OR TG_LEVEL <> 'ROW' OR TG_WHEN <> 'AFTER'
       OR TG_OP NOT IN ('INSERT', 'UPDATE', 'DELETE')
       OR NOT (
         (TG_TABLE_NAME = 'plan_assignments'
          AND TG_RELID = 'public.plan_assignments'::regclass) OR
         (TG_TABLE_NAME = 'plan_assignment_trainings'
          AND TG_RELID = 'public.plan_assignment_trainings'::regclass)
       ) THEN
      RAISE EXCEPTION 'Untrusted adherence assignment capture trigger context'
        USING ERRCODE = '42501';
    END IF;

    INSERT INTO public.adherence_assignment_journal
      (transaction_id, source_table, operation, old_row, new_row)
    VALUES (pg_current_xact_id()::text, TG_TABLE_NAME, TG_OP,
      CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) ELSE NULL END,
      CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) ELSE NULL END);
    RETURN NULL;
END;
$$;

-- Existing installed triggers do not require callers to have EXECUTE. Revoking
-- it blocks direct calls and attachment to attacker-owned tables; context checks
-- also reject spoof tables attached by an otherwise authorized DDL owner.
REVOKE EXECUTE ON FUNCTION public.capture_adherence_assignment_event() FROM PUBLIC;

COMMIT;
