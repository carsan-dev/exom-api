BEGIN;
ALTER TABLE training_exercises ADD COLUMN timed_config JSONB;

CREATE FUNCTION exom_timed_config_valid(c JSONB) RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE s JSONB;
BEGIN
  IF c IS NULL THEN RETURN true; END IF;
  IF jsonb_typeof(c) IS DISTINCT FROM 'object' OR c->'version' IS DISTINCT FROM '1'::jsonb
    OR NOT COALESCE(c->>'unit' IN ('SECONDS','MINUTES'),false)
    OR jsonb_typeof(c->'segments') IS DISTINCT FROM 'array'
    OR c - 'version' - 'unit' - 'segments' <> '{}'::jsonb THEN RETURN false; END IF;
  IF jsonb_array_length(c->'segments') > 20 THEN RETURN false; END IF;
  FOR s IN SELECT value FROM jsonb_array_elements(c->'segments') LOOP
    IF jsonb_typeof(s) IS DISTINCT FROM 'object' OR jsonb_typeof(s->'action') IS DISTINCT FROM 'string'
      OR length(btrim(s->>'action')) NOT BETWEEN 1 AND 80 OR NOT COALESCE(s->>'unit' IN ('SECONDS','MINUTES'),false)
      OR jsonb_typeof(s->'seconds') IS DISTINCT FROM 'number'
      OR (s->>'seconds')::numeric <> trunc((s->>'seconds')::numeric)
      OR (s->>'seconds')::numeric NOT BETWEEN 1 AND 2147483647
      OR s - 'action' - 'unit' - 'seconds' <> '{}'::jsonb THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END $$;
ALTER TABLE training_exercises ADD CONSTRAINT training_timed_config_valid CHECK (
  exom_timed_config_valid(timed_config) AND (timed_config IS NULL OR
    (measure_type IS NOT DISTINCT FROM 'SECONDS'::"TrainingMeasureType" AND
      (jsonb_array_length(timed_config->'segments') = 0 OR target_value IS NOT NULL)))
);
-- Capture available prescriptions, never infer content that predates this migration.
-- Scope: trainings containing time prescriptions. Reuse catalog -> client lock order.
CREATE TABLE training_day_snapshots (
  client_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
  date DATE NOT NULL,
  training_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  source TEXT NOT NULL DEFAULT 'captured',
  version INTEGER NOT NULL DEFAULT 1 CHECK(version=1),
  PRIMARY KEY(client_id,date,training_id)
);
CREATE FUNCTION exom_capture_timed_day_for(c TEXT,d DATE,include_training TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM users WHERE id=c) THEN RETURN; END IF;
  INSERT INTO training_day_snapshots(client_id,date,training_id,payload)
  SELECT c,d,t.id,to_jsonb(t) || jsonb_build_object(
    'exercises',COALESCE((SELECT jsonb_agg(to_jsonb(e) || jsonb_build_object('exercise',to_jsonb(x), 'block',to_jsonb(b)) ORDER BY e."order")
      FROM training_exercises e JOIN exercises x ON x.id=e.exercise_id LEFT JOIN training_blocks b ON b.id=e.block_id WHERE e.training_id=t.id),'[]'::jsonb),
    'blocks',COALESCE((SELECT jsonb_agg(to_jsonb(b) || jsonb_build_object('exercises',COALESCE((SELECT jsonb_agg(to_jsonb(e) || jsonb_build_object('exercise',to_jsonb(x)) ORDER BY e.position_in_block)
      FROM training_exercises e JOIN exercises x ON x.id=e.exercise_id WHERE e.block_id=b.id),'[]'::jsonb)) ORDER BY b."order") FROM training_blocks b WHERE b.training_id=t.id),'[]'::jsonb))
  FROM plan_assignments a JOIN trainings t ON t.id IN (
    SELECT l.training_id FROM plan_assignment_trainings l WHERE l.assignment_id=a.id
    UNION SELECT a.training_id WHERE NOT EXISTS(SELECT 1 FROM plan_assignment_trainings l WHERE l.assignment_id=a.id))
  WHERE a.client_id=c AND a.date=d AND NOT a.is_rest_day
    AND (t.id=include_training OR EXISTS(SELECT 1 FROM training_exercises e WHERE e.training_id=t.id AND (e.measure_type='SECONDS' OR e.timed_config IS NOT NULL)))
  ON CONFLICT DO NOTHING;
END $$;

CREATE FUNCTION exom_capture_timed_day(c TEXT,d DATE) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN PERFORM exom_capture_timed_day_for(c,d,NULL); END $$;

-- Before replacing an all-REPS training with time-based items, capture its old
-- content while it still exists. Caller holds the catalogue barrier already.
CREATE FUNCTION exom_capture_before_time_write(tid TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE a RECORD;
BEGIN
  FOR a IN SELECT DISTINCT p.client_id,p.date FROM plan_assignments p
    WHERE (p.training_id=tid OR EXISTS(SELECT 1 FROM plan_assignment_trainings l WHERE l.assignment_id=p.id AND l.training_id=tid))
      AND exom_rir_protected(p.client_id,p.date)
    ORDER BY p.client_id,p.date LOOP
    PERFORM exom_rir_lock_client(a.client_id);
    PERFORM exom_capture_timed_day_for(a.client_id,a.date,tid);
  END LOOP;
END $$;

CREATE FUNCTION exom_timed_consumer_before() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE c TEXT; d DATE;
BEGIN
  IF TG_TABLE_NAME='plan_assignment_trainings' THEN
    SELECT client_id,date INTO c,d FROM plan_assignments WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.assignment_id ELSE NEW.assignment_id END;
  ELSE
    c:=CASE WHEN TG_OP='DELETE' THEN OLD.client_id ELSE NEW.client_id END;
    d:=CASE WHEN TG_OP='DELETE' THEN OLD.date ELSE NEW.date END;
  END IF;
  IF c IS NOT NULL THEN
    PERFORM exom_rir_lock_client(c);
    IF exom_rir_protected(c,d) THEN
      PERFORM exom_capture_timed_day(c,d);
    ELSIF TG_TABLE_NAME='day_progress' AND TG_OP<>'DELETE' THEN
      IF NEW.training_completed OR cardinality(NEW.trainings_completed)>0 OR NEW.exercises_completed<>'[]'::jsonb OR cardinality(NEW.meals_completed)>0 OR NULLIF(btrim(NEW.notes),'') IS NOT NULL THEN
        PERFORM exom_capture_timed_day(c,d);
      END IF;
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['plan_assignments','plan_assignment_trainings','day_progress'] LOOP
    EXECUTE format('CREATE TRIGGER timed_consumer_before BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION exom_timed_consumer_before()',t);
  END LOOP;
END $$;

CREATE FUNCTION exom_timed_catalog_before() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE a RECORD; tids TEXT[]; incoming_time BOOLEAN := false;
BEGIN
  IF TG_TABLE_NAME='trainings' THEN tids:=ARRAY[OLD.id];
  ELSIF TG_TABLE_NAME='training_blocks' OR TG_TABLE_NAME='training_exercises' THEN tids:=ARRAY[OLD.training_id];
  ELSE SELECT array_agg(DISTINCT training_id) INTO tids FROM training_exercises WHERE exercise_id=OLD.id;
  END IF;
  IF TG_TABLE_NAME='training_exercises' AND TG_OP='UPDATE' THEN incoming_time:=NEW.measure_type='SECONDS'; END IF;
  FOR a IN SELECT DISTINCT p.client_id,p.date FROM plan_assignments p
    WHERE (p.training_id=ANY(tids) OR EXISTS(SELECT 1 FROM plan_assignment_trainings l WHERE l.assignment_id=p.id AND l.training_id=ANY(tids)))
      AND exom_rir_protected(p.client_id,p.date)
    ORDER BY p.client_id,p.date LOOP
    PERFORM exom_rir_lock_client(a.client_id);
    PERFORM exom_capture_timed_day_for(a.client_id,a.date,CASE WHEN incoming_time THEN tids[1] ELSE NULL END);
  END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['trainings','training_exercises','training_blocks','exercises'] LOOP
    EXECUTE format('CREATE TRIGGER timed_catalog_barrier BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH STATEMENT EXECUTE FUNCTION exom_diet_history_barrier(''catalog'')',t);
    EXECUTE format('CREATE TRIGGER timed_catalog_before BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION exom_timed_catalog_before()',t);
  END LOOP;
END $$;
CREATE FUNCTION exom_timed_snapshot_immutable() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' AND NOT EXISTS(SELECT 1 FROM users WHERE id=OLD.client_id) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Timed training history is immutable' USING ERRCODE='23514';
END $$;
SELECT exom_capture_timed_day(client_id,date) FROM plan_assignments WHERE exom_rir_protected(client_id,date);
UPDATE training_day_snapshots SET source='legacy_available';
CREATE TRIGGER timed_snapshot_immutable BEFORE UPDATE OR DELETE ON training_day_snapshots FOR EACH ROW EXECUTE FUNCTION exom_timed_snapshot_immutable();
COMMIT;
