-- ADH-FREEZE-01 (U1): daily freeze of the structural evaluation basis of each
-- closed UTC day, one immutable row per (client, date).
--
-- This migration only creates the table, its guards, the STABLE constructor
-- and the freeze functions. Scheduling them is an operator activation step
-- kept outside migrations, so this file behaves the same in CI, locally and in
-- production.
--
-- Invariant: the diet is stored by reference (diet_id) and resolved on read,
-- snapshot first, from diet_day_snapshots. While a row of adherence_day_bases
-- has a diet_id, the diet_day_snapshots triggers and the snapshot rows of that
-- client/day must not be removed or pruned.
BEGIN;
-- Bounded wait: the FK takes SHARE ROW EXCLUSIVE on users until COMMIT; a busy
-- users table aborts the migration instead of queueing every users write.
SET LOCAL lock_timeout = '5s';

CREATE TABLE public.adherence_day_bases (
  client_id   TEXT NOT NULL,
  date        DATE NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1,
  provenance  TEXT NOT NULL,
  -- CURRENT_TIMESTAMP is the transaction timestamp: one value per run.
  captured_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  basis       JSONB NOT NULL,
  CONSTRAINT adherence_day_bases_pkey PRIMARY KEY (client_id, date),
  CONSTRAINT adherence_day_bases_client_id_fkey FOREIGN KEY (client_id)
    REFERENCES public.users(id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT adherence_day_bases_version_check CHECK (version = 1),
  CONSTRAINT adherence_day_bases_provenance_check CHECK (provenance IN ('scheduled', 'late')),
  -- IS NOT DISTINCT FROM: a missing key yields NULL, which a CHECK would accept.
  CONSTRAINT adherence_day_bases_basis_check CHECK (
    jsonb_typeof(basis) = 'object'
    AND basis->'version' IS NOT DISTINCT FROM '1'::jsonb
    AND jsonb_typeof(basis->'assigned') IS NOT DISTINCT FROM 'boolean')
);

-- Immutable: only the owning user's FK cascade may discard rows (same rule as
-- exom_immutable_diet_day_snapshot). TRUNCATE is rejected as well.
-- Limitation: the cascade exception reads public.users as the invoker. For an
-- owner WITHOUT BYPASSRLS and with FORCE RLS on users, the user always looks
-- missing, so a plain DELETE would be allowed. In production the owner
-- (postgres) has BYPASSRLS.
CREATE FUNCTION public.exom_immutable_adherence_day_basis() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = OLD.client_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Adherence day bases are immutable' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER immutable_adherence_day_basis
  BEFORE UPDATE OR DELETE ON public.adherence_day_bases
  FOR EACH ROW EXECUTE FUNCTION public.exom_immutable_adherence_day_basis();

CREATE FUNCTION public.exom_reject_adherence_day_basis_truncate() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'Adherence day bases are immutable' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER reject_adherence_day_basis_truncate
  BEFORE TRUNCATE ON public.adherence_day_bases
  FOR EACH STATEMENT EXECUTE FUNCTION public.exom_reject_adherence_day_basis_truncate();

-- Structural part of planBasis + fallbackBases (adherence-evaluation.service.ts),
-- snapshot first. Any change there must be mirrored here.
--
-- Occurrences of one unit: the training_day_snapshots row of the client, date
-- and training when it exists (even with an empty exercise list: decided with
-- EXISTS, since jsonb_agg over zero rows is NULL), otherwise the current
-- catalog. Byte order (COLLATE "C") only makes the stored bytes deterministic.
-- STABLE on purpose: called from the freeze statement it uses that
-- statement's snapshot.
CREATE FUNCTION public.exom_adherence_unit_occurrences(p_client TEXT, p_date DATE, p_training TEXT)
RETURNS JSONB LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM public.training_day_snapshots s
      WHERE s.client_id = p_client AND s.date = p_date AND s.training_id = p_training AND s.version = 1)
    THEN COALESCE((SELECT jsonb_agg(e.value->>'id' ORDER BY e.value->>'id' COLLATE "C")
      FROM public.training_day_snapshots s
      CROSS JOIN LATERAL jsonb_array_elements(s.payload->'exercises') e
      WHERE s.client_id = p_client AND s.date = p_date AND s.training_id = p_training AND s.version = 1),
      '[]'::jsonb)
    ELSE COALESCE((SELECT jsonb_agg(x.id ORDER BY x.id COLLATE "C")
      FROM public.training_exercises x WHERE x.training_id = p_training), '[]'::jsonb)
  END;
$$;

-- Payload v1: {"version":1,"assigned":false} without assignment; otherwise the
-- assignment id (diagnostic only), rest flag, completion mode (kept on rest
-- days), diet_id by reference and the units: links by position, or the
-- inherited unit (id = assignment id) when there is no link; none on rest days.
CREATE FUNCTION public.exom_adherence_day_basis(p_client TEXT, p_date DATE)
RETURNS JSONB LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
  SELECT CASE WHEN a.id IS NULL THEN jsonb_build_object('version', 1, 'assigned', false)
  ELSE jsonb_build_object(
    'version', 1,
    'assigned', true,
    'assignment_id', a.id,
    'rest', a.is_rest_day,
    'completion_mode', a.training_completion_mode::text,
    'diet_id', a.diet_id,
    'units', CASE WHEN a.is_rest_day THEN '[]'::jsonb ELSE COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
          'id', u.id,
          'training_id', u.training_id,
          'occurrences', public.exom_adherence_unit_occurrences(p_client, p_date, u.training_id))
        ORDER BY u.position)
      FROM (
        SELECT l.id, l.training_id, l.position
        FROM public.plan_assignment_trainings l
        WHERE l.assignment_id = a.id
        UNION ALL
        SELECT a.id, a.training_id, 0
        WHERE a.training_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM public.plan_assignment_trainings l WHERE l.assignment_id = a.id)
      ) u), '[]'::jsonb) END)
  END
  FROM (SELECT 1) one
  LEFT JOIN public.plan_assignments a ON a.client_id = p_client AND a.date = p_date;
$$;

-- Freezes the UTC day closed at p_now (D = p_now's UTC date - 1) and recovers
-- missed nights: range [max(today - p_catchup_days, earliest stored date or D), D].
-- Every CLIENT created before the end of each day is selected (P1). One single
-- INSERT ... SELECT reads every source with one snapshot (READ COMMITTED);
-- all or nothing; idempotent through the primary key. A row is 'scheduled'
-- only for D and only while the real clock, GREATEST(p_now,
-- transaction_timestamp()), is within p_on_time_grace after D's end; 'late'
-- otherwise. So a manual run with an old p_now never labels a day frozen
-- today with today's state as 'scheduled'.
-- lock_timeout 35s: the FK check (FOR KEY SHARE on users) waits behind the
-- API per-client mutex (SELECT ... FROM users ... FOR UPDATE), held by
-- transactions of up to 30 s.
-- Errors carry only the SQLSTATE: no identifiers reach logs or job history.
CREATE FUNCTION public.exom_freeze_adherence_day_bases_at(
  p_now TIMESTAMPTZ,
  p_catchup_days INTEGER DEFAULT 7,
  p_on_time_grace INTERVAL DEFAULT '2 hours'
) RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = pg_catalog SET TimeZone = 'UTC' SET lock_timeout = '35s' AS $$
DECLARE
  v_today DATE;
  v_to DATE;
  v_from DATE;
  v_first DATE;
  v_targets BIGINT;
  v_inserted BIGINT;
  v_late BIGINT;
BEGIN
  IF p_now IS NULL OR p_now > pg_catalog.transaction_timestamp() THEN
    RAISE EXCEPTION 'adherence day freeze: p_now must not be null nor in the future'
      USING ERRCODE = '22023';
  END IF;
  IF p_catchup_days IS NULL OR p_catchup_days < 1 OR p_catchup_days > 31 THEN
    RAISE EXCEPTION 'adherence day freeze: p_catchup_days must be between 1 and 31'
      USING ERRCODE = '22023';
  END IF;
  IF p_on_time_grace IS NULL OR p_on_time_grace < interval '0' THEN
    RAISE EXCEPTION 'adherence day freeze: p_on_time_grace must be a non-negative interval'
      USING ERRCODE = '22023';
  END IF;
  -- Fail closed: under active row security the sources could look empty and
  -- every client would be frozen as "not assigned", silently and forever.
  IF pg_catalog.row_security_active('public.users'::pg_catalog.regclass)
    OR pg_catalog.row_security_active('public.plan_assignments'::pg_catalog.regclass)
    OR pg_catalog.row_security_active('public.plan_assignment_trainings'::pg_catalog.regclass)
    OR pg_catalog.row_security_active('public.training_exercises'::pg_catalog.regclass)
    OR pg_catalog.row_security_active('public.training_day_snapshots'::pg_catalog.regclass)
    OR pg_catalog.row_security_active('public.adherence_day_bases'::pg_catalog.regclass) THEN
    RAISE EXCEPTION 'adherence day freeze: row security active' USING ERRCODE = '42501';
  END IF;

  BEGIN
    v_today := (p_now AT TIME ZONE 'UTC')::date;
    v_to := v_today - 1;
    SELECT min(b.date) INTO v_first FROM public.adherence_day_bases b;
    v_from := GREATEST(v_today - p_catchup_days, COALESCE(v_first, v_to));

    WITH targets AS (
      SELECT u.id AS client_id, v_from + i AS date
      FROM public.users u
      CROSS JOIN pg_catalog.generate_series(0, v_to - v_from) i
      WHERE u.role = 'CLIENT'
        AND u.created_at < (v_from + i + 1)::timestamp
    ), inserted AS (
      INSERT INTO public.adherence_day_bases (client_id, date, provenance, basis)
      SELECT t.client_id, t.date,
        CASE WHEN t.date = v_to
              AND GREATEST(p_now, pg_catalog.transaction_timestamp())
                < ((v_to + 1)::timestamp AT TIME ZONE 'UTC') + p_on_time_grace
             THEN 'scheduled' ELSE 'late' END,
        public.exom_adherence_day_basis(t.client_id, t.date)
      FROM targets t
      ORDER BY t.client_id COLLATE "C", t.date
      ON CONFLICT (client_id, date) DO NOTHING
      RETURNING provenance
    )
    SELECT (SELECT count(*) FROM targets), count(*), count(*) FILTER (WHERE provenance = 'late')
    INTO v_targets, v_inserted, v_late
    FROM inserted;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'adherence day freeze failed (SQLSTATE %)', SQLSTATE USING ERRCODE = SQLSTATE;
  END;

  RETURN jsonb_build_object(
    'from', to_char(v_from, 'YYYY-MM-DD'),
    'to', to_char(v_to, 'YYYY-MM-DD'),
    'targets', v_targets,
    'inserted', v_inserted,
    'late', v_late);
END $$;

-- Entry point for the scheduler: freezes the day that closed before this
-- transaction started.
CREATE FUNCTION public.exom_freeze_adherence_day_bases() RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = pg_catalog SET TimeZone = 'UTC' SET lock_timeout = '35s' AS $$
BEGIN
  RETURN public.exom_freeze_adherence_day_bases_at(pg_catalog.transaction_timestamp());
END $$;

-- API-only data: RLS on without policies; no direct client access.
ALTER TABLE public.adherence_day_bases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.adherence_day_bases FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.exom_immutable_adherence_day_basis() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.exom_reject_adherence_day_basis_truncate() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.exom_adherence_unit_occurrences(TEXT, DATE, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.exom_adherence_day_basis(TEXT, DATE) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.exom_freeze_adherence_day_bases_at(TIMESTAMPTZ, INTEGER, INTERVAL) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.exom_freeze_adherence_day_bases() FROM PUBLIC;
DO $$
DECLARE r TEXT;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.adherence_day_bases FROM %I', r);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.exom_immutable_adherence_day_basis() FROM %I', r);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.exom_reject_adherence_day_basis_truncate() FROM %I', r);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.exom_adherence_unit_occurrences(TEXT, DATE, TEXT) FROM %I', r);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.exom_adherence_day_basis(TEXT, DATE) FROM %I', r);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.exom_freeze_adherence_day_bases_at(TIMESTAMPTZ, INTEGER, INTERVAL) FROM %I', r);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.exom_freeze_adherence_day_bases() FROM %I', r);
    END IF;
  END LOOP;
END $$;

COMMENT ON TABLE public.adherence_day_bases IS
  'Immutable structural evaluation basis of each closed UTC day, frozen by exom_freeze_adherence_day_bases(). Diet by reference: diet_day_snapshots must be kept for days with a diet_id.';

COMMIT;
