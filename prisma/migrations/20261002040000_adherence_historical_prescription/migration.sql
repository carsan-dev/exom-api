-- Internal immutable T2 membership read model. Catalog projection is NOT the
-- effective training prescription: original13 cannot prove snapshot/RIR overlays.
-- No User/catalog FK: later deletion/edit does
-- not rewrite a closed prescription. Deployment grants SELECT on this table to
-- the application reader role; never grant it baseline/journal/publisher access.
BEGIN;
CREATE TABLE public.adherence_historical_prescriptions (
  client_id text NOT NULL,
  date date NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY (client_id, date),
  CHECK (payload->'prescription'->>'client_id' = client_id),
  CHECK (payload->'prescription'->>'date' = date::text)
);
REVOKE ALL ON public.adherence_historical_prescriptions FROM PUBLIC;
CREATE TRIGGER adherence_prescriptions_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON public.adherence_historical_prescriptions
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_adherence_history_mutation();

CREATE FUNCTION public.assert_adherence_prescription_owner() RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  PERFORM public.assert_adherence_cut_owner();
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c
    WHERE c.oid = 'public.adherence_historical_prescriptions'::regclass
      AND c.relowner <> (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = current_user)) THEN
    RAISE EXCEPTION 'Prescription requires history owner' USING ERRCODE = '42501';
  END IF;
END;
$$;

-- One coherent owner-session query supplies the ORIGINAL inputs only. Restored
-- durable proof validation is reused, not XID metadata or current source rows.
CREATE FUNCTION public.adherence_prescription_source(p_epoch text, p_origin text, p_cutoff text)
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

-- Invoker-only private writer. Application readers need SELECT on the read model
-- only. Exact replay is accepted; conflicts serialize on the unique client/date.
CREATE FUNCTION public.publish_adherence_prescription(p_client text, p_date date,
  p_epoch text, p_origin text, p_cutoff text, p_prescription jsonb, p_manifest_digest text)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog SET TimeZone = 'UTC' SET DateStyle = 'ISO, YMD' AS $$
DECLARE cut jsonb; binding jsonb; payload jsonb; stored jsonb;
BEGIN
  PERFORM public.assert_adherence_prescription_owner();
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
      WHERE u->'effective_content'->>'basis' IS DISTINCT FROM 'unknown'
        OR u->'effective_content'->>'reason' IS DISTINCT FROM 'unproven_original_training_snapshot_and_rir_targets'
        OR u->'effective_rir'->>'basis' IS DISTINCT FROM 'unknown'
        OR u->'effective_rir'->>'reason' IS DISTINCT FROM 'unproven_original_rir_day_targets'
        OR u->'catalog_projection'->'authoritative' IS DISTINCT FROM 'false'::jsonb
        OR u ? 'training')
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
REVOKE EXECUTE ON FUNCTION public.assert_adherence_prescription_owner() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.adherence_prescription_source(text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.publish_adherence_prescription(text, date, text, text, text, jsonb, text) FROM PUBLIC;
COMMENT ON TABLE public.adherence_historical_prescriptions IS
  'Immutable closed client/date membership basis. SELECT-only application read model; owner-only publisher. Effective training content/RIR UNKNOWN; catalog projection explicitly nonauthoritative. Assigned nutrition UNKNOWN until original overlay precedence is authenticated. No evaluation or completion data.';
COMMIT;
