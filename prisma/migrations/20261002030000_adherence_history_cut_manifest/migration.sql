-- PG17 owner-only cut. Trusted UTC clock and no privileged maintenance are
-- explicit operating prerequisites, not properties inferred from database IDs.
BEGIN;
CREATE TABLE public.adherence_history_cuts (
    epoch_id TEXT NOT NULL REFERENCES public.adherence_history_epochs(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
    origin TEXT NOT NULL CHECK (length(origin) > 0),
    cutoff_utc TEXT NOT NULL CHECK (cutoff_utc ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$'),
    manifest JSONB NOT NULL,
    PRIMARY KEY (epoch_id, origin, cutoff_utc)
);
ALTER TABLE public.adherence_history_cuts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.adherence_history_cuts FROM PUBLIC;
CREATE TRIGGER adherence_history_cuts_append_only
    BEFORE UPDATE OR DELETE OR TRUNCATE ON public.adherence_history_cuts
    FOR EACH STATEMENT EXECUTE FUNCTION public.reject_adherence_history_mutation();

CREATE FUNCTION public.assert_adherence_cut_owner() RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    PERFORM public.assert_adherence_commit_owner();
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      WHERE c.oid = 'public.adherence_history_cuts'::regclass
      AND (c.relowner <> (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = current_user)
        OR c.relforcerowsecurity)) THEN
      RAISE EXCEPTION 'Cut requires trusted history owner' USING ERRCODE = '42501';
    END IF;
END;
$$;

-- SQL grouping; bounded array includes activation even when it produced no events.
-- Never use sequence ordering as commit time; it bounds membership only.
CREATE FUNCTION public.adherence_cut_universe(p_epoch text, p_barrier bigint, p_max integer)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE e public.adherence_history_epochs%ROWTYPE; ids jsonb;
BEGIN
    PERFORM public.assert_adherence_cut_owner();
    SELECT * INTO e FROM public.adherence_history_epochs WHERE id = p_epoch;
    IF NOT FOUND OR p_barrier IS NULL OR p_max IS NULL OR p_barrier < e.sequence_boundary OR p_max NOT BETWEEN 1 AND 128 THEN RETURN NULL; END IF;
    SELECT jsonb_agg(u.xid ORDER BY u.xid::numeric) INTO ids FROM (
      SELECT DISTINCT j.xid FROM (
        SELECT e.activating_full_xid xid
        UNION ALL SELECT a.transaction_id FROM public.adherence_assignment_journal a
          WHERE a.event_sequence > e.sequence_boundary AND a.event_sequence <= p_barrier
        UNION ALL SELECT c.transaction_id FROM public.adherence_catalog_journal c
          WHERE c.event_sequence > e.sequence_boundary AND c.event_sequence <= p_barrier
      ) j LIMIT p_max + 1
    ) u;
    IF jsonb_array_length(ids) > p_max THEN RETURN NULL; END IF;
    RETURN ids;
END;
$$;

CREATE FUNCTION public.begin_adherence_history_cut(p_epoch text, p_cutoff text, p_max integer)
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
      public.trainings IN SHARE ROW EXCLUSIVE MODE;
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

-- Frozen-window membership plus ENTIRE transaction payload proofs. Later new
-- transactions beyond the frozen barrier do not invalidate an existing cut.
-- Canonical v1: PG17 jsonb::text, UTC/ISO, UTF8, pg_catalog.sha256.
CREATE FUNCTION public.adherence_cut_payload(p_epoch text, p_origin text, p_cutoff text, p_barrier bigint)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog SET TimeZone = 'UTC' SET DateStyle = 'ISO, YMD' AS $$
DECLARE
    e public.adherence_history_epochs%ROWTYPE; ids jsonb; events jsonb;
    proofs jsonb; activation jsonb; binding jsonb; na bigint; nc bigint;
BEGIN
    PERFORM public.assert_adherence_cut_owner();
    SELECT * INTO e FROM public.adherence_history_epochs WHERE id = p_epoch;
    IF NOT FOUND OR p_origin IS NULL OR length(p_origin) = 0 OR p_cutoff IS NULL
      OR p_cutoff !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$' THEN RETURN NULL; END IF;
    ids := public.adherence_cut_universe(p_epoch, p_barrier, 128);
    IF ids IS NULL THEN RETURN NULL; END IF;
    SELECT jsonb_agg(v.proof ORDER BY v.xid::numeric) INTO proofs FROM (
      SELECT x.xid, public.read_adherence_commit_evidence(p_epoch, p_origin, x.xid) proof
      FROM jsonb_array_elements_text(ids) x(xid)
    ) v;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(proofs) p WHERE p->>'state' IS DISTINCT FROM 'proof') THEN RETURN NULL; END IF;
    SELECT p->'proof' INTO activation FROM jsonb_array_elements(proofs) p
      WHERE p->'proof'->>'full_xid' = e.activating_full_xid;
    IF activation IS NULL OR (activation->>'timestamp_utc')::timestamptz > p_cutoff::timestamptz THEN RETURN NULL; END IF;
    SELECT coalesce(jsonb_agg(jsonb_build_object('kind', j.kind, 'event', j.image)
        ORDER BY j.event_sequence, j.kind COLLATE "C"), '[]'::jsonb),
      count(*) FILTER (WHERE j.kind = 'assignment'), count(*) FILTER (WHERE j.kind = 'catalog')
      INTO events, na, nc FROM (
        SELECT 'assignment'::text kind, a.event_sequence, to_jsonb(a) image
          FROM public.adherence_assignment_journal a
          WHERE a.event_sequence > e.sequence_boundary AND a.event_sequence <= p_barrier
        UNION ALL
        SELECT 'catalog'::text kind, c.event_sequence, to_jsonb(c) image
          FROM public.adherence_catalog_journal c
          WHERE c.event_sequence > e.sequence_boundary AND c.event_sequence <= p_barrier
      ) j;
    binding := jsonb_build_object('digest_version', 1, 'epoch_id', p_epoch, 'origin', p_origin,
      'cutoff_utc', p_cutoff, 'cutoff_microseconds', (extract(epoch FROM p_cutoff::timestamptz) * 1000000)::numeric(30,0)::text,
      'epoch_boundary', e.sequence_boundary::text, 'barrier_boundary', p_barrier::text,
      'activation_full_xid', e.activating_full_xid, 'baseline_digest', activation->>'baseline_digest',
      'membership_digest', encode(sha256(convert_to(events::text, 'UTF8')), 'hex'),
      'assignment_count', na::text, 'catalog_count', nc::text,
      'transaction_count', jsonb_array_length(ids)::text, 'full_xids', ids, 'proofs', proofs);
    RETURN binding || jsonb_build_object('manifest_digest', encode(sha256(convert_to(binding::text, 'UTF8')), 'hex'));
END;
$$;

CREATE FUNCTION public.read_adherence_history_cut(p_epoch text, p_origin text, p_cutoff text)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE stored jsonb; expected jsonb;
BEGIN
    PERFORM public.assert_adherence_cut_owner();
    SELECT manifest INTO stored FROM public.adherence_history_cuts
      WHERE epoch_id = p_epoch AND origin = p_origin AND cutoff_utc = p_cutoff;
    IF NOT FOUND THEN RETURN jsonb_build_object('state', 'missing'); END IF;
    expected := public.adherence_cut_payload(p_epoch, p_origin, p_cutoff, (stored->>'barrier_boundary')::bigint);
    IF expected IS NULL OR stored IS DISTINCT FROM expected THEN RETURN jsonb_build_object('state', 'invalid'); END IF;
    RETURN jsonb_build_object('state', 'cut', 'manifest', stored);
END;
$$;

CREATE FUNCTION public.issue_adherence_history_cut(p_epoch text, p_origin text, p_cutoff text, p_barrier bigint)
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
REVOKE EXECUTE ON FUNCTION public.assert_adherence_cut_owner() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.adherence_cut_universe(text, bigint, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.begin_adherence_history_cut(text, text, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.adherence_cut_payload(text, text, text, bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.read_adherence_history_cut(text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.issue_adherence_history_cut(text, text, text, bigint) FROM PUBLIC;
COMMENT ON TABLE public.adherence_history_cuts IS
  'Private immutable complete bounded cut; trusted PG UTC clock/owner/no privileged maintenance prerequisite. Missing original proof or payload validation means UNKNOWN, including after restore. No legacy historical truth claim.';
COMMIT;
