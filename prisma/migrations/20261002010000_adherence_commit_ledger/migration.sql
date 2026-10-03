-- Owner-controlled conditional evidence, not a complete transaction universe.
-- The authenticated external origin/fence provider is an operational prerequisite.
-- Database IDs, copied epochs and uniqueness DO NOT authenticate continuity.
BEGIN;
CREATE TABLE public.adherence_commit_evidence (
    epoch_id TEXT NOT NULL REFERENCES public.adherence_history_epochs(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
    origin TEXT NOT NULL CHECK (length(origin) > 0),
    full_xid TEXT NOT NULL CHECK (full_xid ~ '^[1-9][0-9]*$' AND full_xid::numeric <= 18446744073709551615),
    digest_version INTEGER NOT NULL CHECK (digest_version = 1),
    baseline_digest TEXT NOT NULL CHECK (baseline_digest ~ '^[0-9a-f]{64}$'),
    event_digest TEXT NOT NULL CHECK (event_digest ~ '^[0-9a-f]{64}$'),
    content_digest TEXT NOT NULL CHECK (content_digest ~ '^[0-9a-f]{64}$'),
    proof_digest TEXT NOT NULL CHECK (proof_digest ~ '^[0-9a-f]{64}$'),
    event_count TEXT NOT NULL CHECK (event_count ~ '^(0|[1-9][0-9]*)$'),
    activation BOOLEAN NOT NULL,
    timestamp_utc TEXT NOT NULL CHECK (timestamp_utc ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$'),
    microseconds TEXT NOT NULL CHECK (microseconds ~ '^-?(0|[1-9][0-9]*)$'),
    PRIMARY KEY (epoch_id, origin, full_xid),
    CHECK (microseconds::numeric = extract(epoch FROM timestamp_utc::timestamptz) * 1000000),
    CHECK (activation OR event_count::numeric > 0)
);
ALTER TABLE public.adherence_commit_evidence ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.adherence_commit_evidence FROM PUBLIC;
CREATE TRIGGER adherence_commit_evidence_append_only
    BEFORE UPDATE OR DELETE OR TRUNCATE ON public.adherence_commit_evidence
    FOR EACH STATEMENT EXECUTE FUNCTION public.reject_adherence_history_mutation();

-- No SECURITY DEFINER or runtime grants. Even an accidentally granted EXECUTE
-- cannot use these functions as a privileged journal reader/writer.
CREATE FUNCTION public.assert_adherence_commit_owner() RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      WHERE c.oid IN ('public.adherence_commit_evidence'::regclass,
        'public.adherence_history_epochs'::regclass,
        'public.adherence_history_baselines'::regclass,
        'public.adherence_assignment_journal'::regclass,
        'public.adherence_catalog_journal'::regclass)
      AND (c.relowner <> (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = current_user)
        OR c.relforcerowsecurity)) THEN
      RAISE EXCEPTION 'Commit evidence requires the trusted history owner' USING ERRCODE = '42501';
    END IF;
END;
$$;

-- v1 canonical contract: PG17 jsonb::text encoded UTF8, built-in SHA256(bytea).
-- sha256 is pg_catalog, requires no extension and is NOT MD5 or a JS serializer.
-- Fixed UTC/ISO formatting prevents session timezone/DateStyle digest changes.
-- Complete to_jsonb(row) binds every field, including OLD/NEW/null/observation.
-- Shared sequence order plus explicit journal kind binds transaction membership.
-- Full epoch row + sorted complete baseline rows binds activation/legacy boundary.
-- Future schema/canonical representation changes require a NEW digest version.
CREATE FUNCTION public.adherence_commit_payload(p_epoch text, p_xid text) RETURNS jsonb
LANGUAGE plpgsql SET search_path = pg_catalog SET TimeZone = 'UTC' SET DateStyle = 'ISO, YMD' AS $$
DECLARE
    e public.adherence_history_epochs%ROWTYPE;
    baselines jsonb;
    events jsonb;
    n bigint;
    before_boundary boolean;
    bd text;
    ed text;
    binding jsonb;
BEGIN
    PERFORM public.assert_adherence_commit_owner();
    IF p_xid IS NULL OR p_xid !~ '^[1-9][0-9]*$' OR p_xid::numeric > 18446744073709551615 THEN
      RETURN NULL;
    END IF;
    SELECT * INTO e FROM public.adherence_history_epochs WHERE id = p_epoch;
    IF NOT FOUND OR p_xid::numeric < e.activating_full_xid::numeric THEN RETURN NULL; END IF;
    SELECT coalesce(jsonb_agg(to_jsonb(b) ORDER BY b.source_table COLLATE "C", b.row_key COLLATE "C"), '[]'::jsonb)
      INTO baselines FROM public.adherence_history_baselines b WHERE b.epoch_id = p_epoch;
    SELECT coalesce(jsonb_agg(jsonb_build_object('kind', j.kind, 'event', j.image)
        ORDER BY j.event_sequence, j.kind COLLATE "C"), '[]'::jsonb),
        count(*), coalesce(bool_or(j.event_sequence <= e.sequence_boundary), false)
      INTO events, n, before_boundary FROM (
        SELECT 'assignment'::text kind, a.event_sequence, to_jsonb(a) image
          FROM public.adherence_assignment_journal a WHERE a.transaction_id = p_xid
        UNION ALL
        SELECT 'catalog'::text kind, c.event_sequence, to_jsonb(c) image
          FROM public.adherence_catalog_journal c WHERE c.transaction_id = p_xid
      ) j;
    IF p_xid <> e.activating_full_xid AND (n = 0 OR before_boundary) THEN RETURN NULL; END IF;
    bd := encode(sha256(convert_to(jsonb_build_object('epoch', to_jsonb(e), 'baselines', baselines)::text, 'UTF8')), 'hex');
    ed := encode(sha256(convert_to(events::text, 'UTF8')), 'hex');
    binding := jsonb_build_object('digest_version', 1, 'epoch_id', p_epoch,
      'full_xid', p_xid, 'baseline_digest', bd, 'event_digest', ed,
      'event_count', n::text, 'activation', p_xid = e.activating_full_xid);
    RETURN binding || jsonb_build_object('content_digest', encode(sha256(convert_to(binding::text, 'UTF8')), 'hex'));
END;
$$;

-- Distinguish corrupt evidence from absence: callers MUST NOT reissue on invalid.
CREATE FUNCTION public.read_adherence_commit_evidence(p_epoch text, p_origin text, p_xid text) RETURNS jsonb
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
    proof public.adherence_commit_evidence%ROWTYPE;
    payload jsonb;
BEGIN
    PERFORM public.assert_adherence_commit_owner();
    SELECT * INTO proof FROM public.adherence_commit_evidence
      WHERE epoch_id = p_epoch AND origin = p_origin AND full_xid = p_xid;
    IF NOT FOUND THEN RETURN jsonb_build_object('state', 'missing'); END IF;
    payload := public.adherence_commit_payload(p_epoch, p_xid);
    IF payload IS NULL OR payload <> (to_jsonb(proof) - ARRAY['origin', 'timestamp_utc', 'microseconds', 'proof_digest'])
      OR proof.proof_digest IS DISTINCT FROM encode(sha256(convert_to((to_jsonb(proof) - 'proof_digest')::text, 'UTF8')), 'hex')
      OR proof.microseconds::numeric <> extract(epoch FROM proof.timestamp_utc::timestamptz) * 1000000 THEN
      RETURN jsonb_build_object('state', 'invalid');
    END IF;
    RETURN jsonb_build_object('state', 'proof', 'proof', to_jsonb(proof));
END;
$$;

-- Trusted owner invokes ONLY with conditional resolver output under the SAME
-- external pinned origin fence. SQL cannot authenticate that external authority.
-- Unique insertion waits on the actual competing transaction; no overwrite.
CREATE FUNCTION public.issue_adherence_commit_evidence(p_epoch text, p_origin text, p_xid text,
    p_stamp text, p_micro text, p_digest text) RETURNS jsonb
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
    payload jsonb;
    existing jsonb;
BEGIN
    PERFORM public.assert_adherence_commit_owner();
    -- Serialize epoch-origin binding too, including different-XID issuers.
    -- Row lock only: the epoch image remains immutable.
    PERFORM 1 FROM public.adherence_history_epochs WHERE id = p_epoch FOR UPDATE;
    IF EXISTS (SELECT 1 FROM public.adherence_commit_evidence
      WHERE epoch_id = p_epoch AND origin IS DISTINCT FROM p_origin) THEN
      RAISE EXCEPTION 'Discordant immutable epoch origin' USING ERRCODE = '22000';
    END IF;
    payload := public.adherence_commit_payload(p_epoch, p_xid);
    IF payload IS NULL OR p_origin IS NULL OR length(p_origin) = 0
      OR p_digest IS DISTINCT FROM payload->>'content_digest' THEN
      RAISE EXCEPTION 'Invalid complete commit binding' USING ERRCODE = '22000';
    END IF;
    INSERT INTO public.adherence_commit_evidence
      (epoch_id, origin, full_xid, digest_version, baseline_digest, event_digest,
       content_digest, event_count, activation, timestamp_utc, microseconds, proof_digest)
    VALUES (p_epoch, p_origin, p_xid, 1, payload->>'baseline_digest', payload->>'event_digest',
      p_digest, payload->>'event_count', (payload->>'activation')::boolean, p_stamp, p_micro,
      encode(sha256(convert_to((payload || jsonb_build_object('origin', p_origin,
        'timestamp_utc', p_stamp, 'microseconds', p_micro))::text, 'UTF8')), 'hex'))
    ON CONFLICT (epoch_id, origin, full_xid) DO NOTHING;
    existing := public.read_adherence_commit_evidence(p_epoch, p_origin, p_xid);
    IF existing->>'state' <> 'proof' OR existing->'proof'->>'timestamp_utc' IS DISTINCT FROM p_stamp
      OR existing->'proof'->>'microseconds' IS DISTINCT FROM p_micro
      OR existing->'proof'->>'content_digest' IS DISTINCT FROM p_digest THEN
      RAISE EXCEPTION 'Discordant immutable commit retry' USING ERRCODE = '22000';
    END IF;
    RETURN existing;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.assert_adherence_commit_owner() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.adherence_commit_payload(text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.read_adherence_commit_evidence(text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.issue_adherence_commit_evidence(text, text, text, text, text, text) FROM PUBLIC;
COMMENT ON TABLE public.adherence_commit_evidence IS
  'Private immutable conditional origin-bound evidence; no precapture legacy, universal continuity or cutoff completeness claim. Trusted owner/external authenticated fence required.';
COMMIT;
