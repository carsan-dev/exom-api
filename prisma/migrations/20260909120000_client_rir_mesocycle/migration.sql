BEGIN;
ALTER TABLE trainings ADD COLUMN rir_proposal JSONB;
ALTER TABLE training_exercises ADD COLUMN rir_override JSONB;

CREATE TABLE rir_cycle_versions (
  client_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
  revision INTEGER NOT NULL CHECK (revision > 0),
  operation_id TEXT NOT NULL,
  request JSONB NOT NULL,
  effective_from DATE NOT NULL,
  starts_on DATE NOT NULL,
  config JSONB,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (client_id, revision),
  UNIQUE (client_id, operation_id)
);
CREATE INDEX rir_cycle_effective_idx ON rir_cycle_versions(client_id, effective_from, revision);
CREATE TABLE rir_protected_days (
  client_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
  date DATE NOT NULL,
  PRIMARY KEY (client_id,date)
);
CREATE FUNCTION exom_rir_protected(c TEXT,d DATE) RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT exom_diet_history_protected(c,d) OR EXISTS(SELECT 1 FROM rir_protected_days WHERE client_id=c AND date=d);
$$;
CREATE TABLE rir_day_targets (
  client_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
  date DATE NOT NULL,
  training_exercise_id TEXT NOT NULL,
  training_id TEXT NOT NULL,
  target_rir INTEGER CHECK (target_rir BETWEEN 0 AND 10),
  revision INTEGER,
  captured_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (client_id, date, training_exercise_id)
);

CREATE FUNCTION exom_rir_sequence_valid(s JSONB) RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF s IS NULL OR jsonb_typeof(s) <> 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(s) = 0 THEN RETURN false; END IF;
  RETURN NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s) v WHERE jsonb_typeof(v) <> 'number'
    OR v::text !~ '^(10|[0-9])$');
END $$;
CREATE FUNCTION exom_rir_override_valid(o JSONB, n INTEGER DEFAULT NULL) RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF o IS NULL THEN RETURN true; END IF;
  IF jsonb_typeof(o) <> 'object' THEN RETURN false; END IF;
  IF o->>'mode' IN ('INHERIT','NONE') THEN RETURN o - 'mode' = '{}'::jsonb; END IF;
  IF o->>'mode' = 'FIXED' THEN RETURN o - 'mode' - 'value' = '{}'::jsonb AND COALESCE(o->>'value' ~ '^(10|[0-9])$', false) AND jsonb_typeof(o->'value') = 'number'; END IF;
  IF o->>'mode' = 'SEQUENCE' THEN
    RETURN o - 'mode' - 'sequence' = '{}'::jsonb AND exom_rir_sequence_valid(o->'sequence')
      AND (n IS NULL OR jsonb_array_length(o->'sequence') = n);
  END IF;
  RETURN false;
END $$;
CREATE FUNCTION exom_rir_config_valid(c JSONB) RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE o JSONB;
BEGIN
  IF c IS NULL THEN RETURN true; END IF;
  IF jsonb_typeof(c) <> 'object' OR NOT exom_rir_sequence_valid(c->'sequence') OR jsonb_typeof(c->'overrides') IS DISTINCT FROM 'object' OR c - 'sequence' - 'overrides' <> '{}'::jsonb THEN RETURN false; END IF;
  FOR o IN SELECT value FROM jsonb_each(c->'overrides') LOOP
    IF NOT exom_rir_override_valid(o, jsonb_array_length(c->'sequence')) THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END $$;
ALTER TABLE trainings ADD CONSTRAINT rir_proposal_valid CHECK (rir_proposal IS NULL OR exom_rir_sequence_valid(rir_proposal));
ALTER TABLE training_exercises ADD CONSTRAINT rir_override_valid CHECK (exom_rir_override_valid(rir_override));
ALTER TABLE rir_cycle_versions ADD CONSTRAINT rir_config_valid CHECK (exom_rir_config_valid(config));

CREATE FUNCTION exom_resolve_rir(c JSONB, start_date DATE, target_date DATE, occurrence TEXT, base INTEGER)
RETURNS INTEGER LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE w INTEGER; rule JSONB; seq JSONB;
BEGIN
  IF c IS NULL OR date_trunc('week', target_date::timestamp) < date_trunc('week', start_date::timestamp) THEN RETURN base; END IF;
  w := ((date_trunc('week', target_date::timestamp)::date - date_trunc('week', start_date::timestamp)::date) / 7) % jsonb_array_length(c->'sequence');
  rule := c->'overrides'->occurrence;
  IF rule->>'mode' = 'NONE' THEN RETURN NULL; END IF;
  IF rule->>'mode' = 'FIXED' THEN RETURN (rule->>'value')::integer; END IF;
  seq := CASE WHEN rule->>'mode' = 'SEQUENCE' THEN rule->'sequence' ELSE c->'sequence' END;
  RETURN (seq->>w)::integer;
END $$;

-- All planning/progress consumers share the established catalog barrier and client lock.
CREATE FUNCTION exom_rir_lock_client(c TEXT) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('exom:diet-history', 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('exom:day-progress:' || c, 0));
END $$;

CREATE FUNCTION exom_refresh_rir_day(c TEXT, d DATE) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v rir_cycle_versions;
BEGIN
  IF exom_rir_protected(c, d) OR NOT EXISTS (SELECT 1 FROM users WHERE id = c) THEN RETURN; END IF;
  SELECT * INTO v FROM rir_cycle_versions WHERE client_id = c AND effective_from <= d ORDER BY revision DESC LIMIT 1;
  INSERT INTO rir_day_targets(client_id, date, training_exercise_id, training_id, target_rir, revision)
  SELECT c, d, e.id, e.training_id, exom_resolve_rir(v.config, v.starts_on, d, e.id, e.target_rir), v.revision
  FROM plan_assignments a JOIN training_exercises e ON
    e.training_id IN (SELECT l.training_id FROM plan_assignment_trainings l WHERE l.assignment_id = a.id
      UNION SELECT a.training_id WHERE NOT EXISTS (SELECT 1 FROM plan_assignment_trainings l WHERE l.assignment_id = a.id))
  WHERE a.client_id = c AND a.date = d AND NOT a.is_rest_day
  ON CONFLICT (client_id, date, training_exercise_id) DO UPDATE SET
    target_rir = EXCLUDED.target_rir, revision = EXCLUDED.revision, captured_at = CURRENT_TIMESTAMP
  WHERE rir_day_targets.target_rir IS DISTINCT FROM EXCLUDED.target_rir OR rir_day_targets.revision IS DISTINCT FROM EXCLUDED.revision;
END $$;

CREATE FUNCTION exom_rir_consumer_before() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c TEXT; d DATE;
BEGIN
  IF TG_TABLE_NAME = 'plan_assignment_trainings' THEN
    SELECT client_id, date INTO c,d FROM plan_assignments WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.assignment_id ELSE NEW.assignment_id END;
  ELSIF TG_TABLE_NAME = 'rir_cycle_versions' THEN
    c := NEW.client_id; d := NEW.effective_from;
  ELSE
    c := CASE WHEN TG_OP = 'DELETE' THEN OLD.client_id ELSE NEW.client_id END;
    d := CASE WHEN TG_OP = 'DELETE' THEN OLD.date ELSE NEW.date END;
  END IF;
  IF c IS NOT NULL THEN
    PERFORM exom_rir_lock_client(c);
    -- BEFORE the first progress is recorded, freeze the prescription seen at this date.
    IF TG_TABLE_NAME = 'day_progress' AND TG_OP <> 'DELETE' THEN PERFORM exom_refresh_rir_day(c,d); END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE FUNCTION exom_rir_assignment_after() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c TEXT; d DATE;
BEGIN
  IF TG_TABLE_NAME = 'plan_assignment_trainings' THEN
    SELECT client_id,date INTO c,d FROM plan_assignments WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.assignment_id ELSE NEW.assignment_id END;
  ELSE c := NEW.client_id; d := NEW.date; END IF;
  IF c IS NOT NULL THEN PERFORM exom_refresh_rir_day(c,d); END IF;
  RETURN NULL;
END $$;
DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['plan_assignments','plan_assignment_trainings','day_progress'] LOOP
    EXECUTE format('CREATE TRIGGER rir_consumer_before BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION exom_rir_consumer_before()',t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['plan_assignments','plan_assignment_trainings'] LOOP
    EXECUTE format('CREATE TRIGGER rir_assignment_after AFTER INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION exom_rir_assignment_after()',t);
  END LOOP;
END $$;
CREATE FUNCTION exom_rir_progress_after() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF exom_diet_history_protected(NEW.client_id,NEW.date) THEN
    INSERT INTO rir_protected_days(client_id,date) VALUES(NEW.client_id,NEW.date) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER rir_progress_after AFTER INSERT OR UPDATE ON day_progress FOR EACH ROW EXECUTE FUNCTION exom_rir_progress_after();
CREATE TRIGGER rir_link_delete AFTER DELETE ON plan_assignment_trainings FOR EACH ROW EXECUTE FUNCTION exom_rir_assignment_after();

-- Reuse the exclusive catalog barrier BEFORE any row locks (including raw SQL writers).
CREATE TRIGGER rir_catalog_barrier BEFORE INSERT OR UPDATE OR DELETE ON training_exercises
  FOR EACH STATEMENT EXECUTE FUNCTION exom_diet_history_barrier('catalog');
CREATE TRIGGER rir_training_barrier BEFORE INSERT OR UPDATE OR DELETE ON trainings
  FOR EACH STATEMENT EXECUTE FUNCTION exom_diet_history_barrier('catalog');
CREATE FUNCTION exom_rir_catalog_after() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a RECORD;
BEGIN
  FOR a IN SELECT DISTINCT p.client_id,p.date FROM plan_assignments p
    WHERE p.date >= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date AND
      (p.training_id = NEW.training_id OR EXISTS (SELECT 1 FROM plan_assignment_trainings l WHERE l.assignment_id = p.id AND l.training_id = NEW.training_id))
    ORDER BY p.client_id,p.date LOOP
    PERFORM exom_rir_lock_client(a.client_id);
    PERFORM exom_refresh_rir_day(a.client_id,a.date);
  END LOOP;
  RETURN NULL;
END $$;
CREATE TRIGGER rir_catalog_after AFTER INSERT OR UPDATE ON training_exercises FOR EACH ROW EXECUTE FUNCTION exom_rir_catalog_after();

CREATE FUNCTION exom_rir_version_after() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a RECORD;
BEGIN
  FOR a IN SELECT date FROM plan_assignments WHERE client_id = NEW.client_id AND date >= NEW.effective_from ORDER BY date LOOP
    PERFORM exom_refresh_rir_day(NEW.client_id,a.date);
  END LOOP;
  RETURN NULL;
END $$;
CREATE TRIGGER rir_version_before BEFORE INSERT ON rir_cycle_versions FOR EACH ROW EXECUTE FUNCTION exom_rir_consumer_before();
CREATE TRIGGER rir_version_after AFTER INSERT ON rir_cycle_versions FOR EACH ROW EXECUTE FUNCTION exom_rir_version_after();
CREATE FUNCTION exom_rir_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM users WHERE id = OLD.client_id) THEN RETURN OLD; END IF;
  IF TG_TABLE_NAME = 'rir_day_targets' AND TG_OP = 'UPDATE' AND NOT exom_rir_protected(OLD.client_id,OLD.date)
    AND (OLD.client_id,OLD.date,OLD.training_exercise_id,OLD.training_id) = (NEW.client_id,NEW.date,NEW.training_exercise_id,NEW.training_id) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'RIR history is protected' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER rir_immutable BEFORE UPDATE OR DELETE ON rir_cycle_versions FOR EACH ROW EXECUTE FUNCTION exom_rir_immutable();
CREATE TRIGGER rir_immutable BEFORE UPDATE OR DELETE ON rir_day_targets FOR EACH ROW EXECUTE FUNCTION exom_rir_immutable();
CREATE TRIGGER rir_immutable BEFORE UPDATE OR DELETE ON rir_protected_days FOR EACH ROW EXECUTE FUNCTION exom_rir_immutable();
INSERT INTO rir_protected_days(client_id,date) SELECT client_id,date FROM day_progress WHERE exom_diet_history_protected(client_id,date);
-- No historical backfill. Only mutable current/future dates are captured.
SELECT exom_refresh_rir_day(client_id,date) FROM plan_assignments WHERE date >= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date;
COMMIT;
