-- Scope is a set of invalidated rules, never a delta: delayed/duplicate work
-- reads canonical rows under the owner lock. Empty/unknown legacy payload = full.
ALTER TABLE streaks ADD COLUMN source_revision BIGINT NOT NULL DEFAULT 0;
ALTER TABLE streaks ADD COLUMN calculated_revision BIGINT NOT NULL DEFAULT -1;

CREATE FUNCTION exom_invalidate_aggregates(owner_key TEXT, scopes JSONB) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users WHERE id=owner_key) THEN RETURN; END IF;
  IF scopes IS NULL OR scopes ? 'STREAK_DAYS' THEN
    UPDATE streaks SET source_revision=source_revision+1 WHERE client_id=owner_key;
  END IF;
  INSERT INTO durable_work(key,kind,payload,owner_id)
    VALUES('reconcile:' || owner_key || ':' || txid_current()::text,'RECONCILE',
      CASE WHEN scopes IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('version',1,'scopes',scopes) END,owner_key)
    ON CONFLICT(key) DO UPDATE SET payload = CASE
      WHEN durable_work.payload->>'version'='1' AND EXCLUDED.payload->>'version'='1'
      THEN jsonb_build_object('version',1,'scopes',(durable_work.payload->'scopes') || (EXCLUDED.payload->'scopes'))
      ELSE '{}'::jsonb END;
END $$;

CREATE FUNCTION exom_json_array_length(value JSONB) RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(value)='array' THEN jsonb_array_length(value) ELSE 0 END
$$;
CREATE OR REPLACE FUNCTION exom_queue_reconcile() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_key TEXT; event_key TEXT; scopes JSONB := '{}'; before_row JSONB; after_row JSONB;
BEGIN
  before_row := CASE WHEN TG_OP = 'INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
  after_row := CASE WHEN TG_OP = 'DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END;
  owner_key := COALESCE(after_row->>'client_id', before_row->>'client_id');
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = owner_key) THEN RETURN NULL; END IF;
  IF TG_TABLE_NAME = 'day_progress' THEN
    IF COALESCE((before_row->>'training_completed')::boolean,false) IS DISTINCT FROM COALESCE((after_row->>'training_completed')::boolean,false)
      OR (TG_OP='UPDATE' AND before_row->'date' IS DISTINCT FROM after_row->'date') THEN scopes := scopes || '{"TRAINING_DAYS":true}'; END IF;
    IF exom_json_array_length(before_row->'meals_completed') IS DISTINCT FROM exom_json_array_length(after_row->'meals_completed')
      OR (TG_OP='UPDATE' AND before_row->'date' IS DISTINCT FROM after_row->'date') THEN scopes := scopes || '{"MEAL_CHECKINS":true}'; END IF;
    IF (COALESCE((before_row->>'training_completed')::boolean,false) OR exom_json_array_length(before_row->'exercises_completed')>0 OR exom_json_array_length(before_row->'meals_completed')>0)
      IS DISTINCT FROM (COALESCE((after_row->>'training_completed')::boolean,false) OR exom_json_array_length(after_row->'exercises_completed')>0 OR exom_json_array_length(after_row->'meals_completed')>0)
      OR (TG_OP='UPDATE' AND before_row->'date' IS DISTINCT FROM after_row->'date')
      OR EXISTS (SELECT 1 FROM streaks WHERE client_id=owner_key AND tracking_started_at > (before_row->>'updated_at')::timestamp AND tracking_started_at <= (after_row->>'updated_at')::timestamp)
      THEN scopes := scopes || '{"STREAK_DAYS":true}'; END IF;
  ELSIF TG_TABLE_NAME = 'body_metrics' THEN
    IF (before_row->>'weight_kg' IS NULL) IS DISTINCT FROM (after_row->>'weight_kg' IS NULL)
      OR (TG_OP='UPDATE' AND before_row->'date' IS DISTINCT FROM after_row->'date') THEN scopes := '{"WEIGHT_LOGS":true}'; END IF;
  ELSIF TG_TABLE_NAME = 'streaks' THEN
    IF before_row->'current_days' IS DISTINCT FROM after_row->'current_days' OR before_row->'tracking_started_at' IS DISTINCT FROM after_row->'tracking_started_at' THEN scopes := '{"STREAK_DAYS":true}'; END IF;
  ELSIF TG_TABLE_NAME = 'challenge_clients' THEN
    IF TG_OP <> 'UPDATE' OR before_row->'assigned_at' IS DISTINCT FROM after_row->'assigned_at' OR before_row->'challenge_id' IS DISTINCT FROM after_row->'challenge_id' THEN
      -- Assignment changes can invalidate any challenge window; retain full fallback.
      scopes := NULL;
    ELSIF before_row->'is_completed' IS DISTINCT FROM after_row->'is_completed' THEN scopes := '{"CHALLENGES_COMPLETED":true}'; END IF;
  END IF;
  IF TG_OP='UPDATE' AND before_row->'client_id' IS DISTINCT FROM after_row->'client_id' THEN
    -- Rare administrative ownership corrections must repair both owners.
    PERFORM exom_invalidate_aggregates(before_row->>'client_id',NULL);
    scopes := NULL;
  END IF;
  IF scopes = '{}'::jsonb THEN RETURN NULL; END IF;
  IF TG_TABLE_NAME <> 'streaks' AND (scopes IS NULL OR scopes ? 'STREAK_DAYS') THEN
    UPDATE streaks SET source_revision=source_revision+1 WHERE client_id=owner_key;
  END IF;
  event_key := 'reconcile:' || owner_key || ':' || txid_current()::text;
  INSERT INTO durable_work(key,kind,payload,owner_id)
    VALUES(event_key,'RECONCILE',CASE WHEN scopes IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('version',1,'scopes',scopes) END,owner_key)
    ON CONFLICT(key) DO UPDATE SET payload = CASE
      WHEN durable_work.payload->>'version'='1' AND EXCLUDED.payload->>'version'='1'
      THEN jsonb_build_object('version',1,'scopes',(durable_work.payload->'scopes') || (EXCLUDED.payload->'scopes'))
      ELSE '{}'::jsonb END;
  RETURN NULL;
END $$;

-- Planning and catalog writers include bulk/import/repair paths. Invalidation
-- is cheap; consumers reuse the existing owner lock and canonical rules.
CREATE FUNCTION exom_queue_aggregate_catalog() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_key TEXT; before_row JSONB; after_row JSONB; scopes JSONB;
BEGIN
  before_row := CASE WHEN TG_OP='INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
  after_row := CASE WHEN TG_OP='DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END;
  IF TG_TABLE_NAME='plan_assignments' THEN
    IF TG_OP='UPDATE' AND (before_row - ARRAY['updated_at','notes','admin_id']) = (after_row - ARRAY['updated_at','notes','admin_id']) THEN RETURN NULL; END IF;
    FOR owner_key IN SELECT DISTINCT value FROM jsonb_array_elements_text(jsonb_build_array(before_row->>'client_id',after_row->>'client_id')) WHERE value IS NOT NULL LOOP
      PERFORM exom_invalidate_aggregates(owner_key,'{"TRAINING_DAYS":true,"STREAK_DAYS":true}');
    END LOOP;
  ELSIF TG_TABLE_NAME='plan_assignment_trainings' THEN
    IF TG_OP='UPDATE' AND before_row->'training_id'=after_row->'training_id' AND before_row->'assignment_id'=after_row->'assignment_id' THEN RETURN NULL; END IF;
    FOR owner_key IN SELECT DISTINCT client_id FROM plan_assignments WHERE id IN (before_row->>'assignment_id',after_row->>'assignment_id') LOOP
      PERFORM exom_invalidate_aggregates(owner_key,'{"TRAINING_DAYS":true,"STREAK_DAYS":true}');
    END LOOP;
  ELSIF TG_TABLE_NAME='trainings' THEN
    IF TG_OP='UPDATE' AND before_row->'type' IS NOT DISTINCT FROM after_row->'type' AND before_row->'types' IS NOT DISTINCT FROM after_row->'types' THEN RETURN NULL; END IF;
    FOR owner_key IN SELECT DISTINCT p.client_id FROM plan_assignments p LEFT JOIN plan_assignment_trainings l ON l.assignment_id=p.id WHERE p.training_id=COALESCE(after_row->>'id',before_row->>'id') OR l.training_id=COALESCE(after_row->>'id',before_row->>'id') LOOP
      PERFORM exom_invalidate_aggregates(owner_key,'{"TRAINING_DAYS":true}');
    END LOOP;
  ELSIF TG_TABLE_NAME='challenges' THEN
    IF TG_OP='UPDATE' AND before_row->'rule_key' IS NOT DISTINCT FROM after_row->'rule_key' AND before_row->'target_value' IS NOT DISTINCT FROM after_row->'target_value' AND before_row->'deadline' IS NOT DISTINCT FROM after_row->'deadline' AND before_row->'is_manual' IS NOT DISTINCT FROM after_row->'is_manual' THEN RETURN NULL; END IF;
    FOR owner_key IN SELECT client_id FROM challenge_clients WHERE challenge_id=COALESCE(after_row->>'id',before_row->>'id') LOOP
      PERFORM exom_invalidate_aggregates(owner_key,NULL);
    END LOOP;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER durable_aggregate_plan AFTER INSERT OR UPDATE OR DELETE ON plan_assignments FOR EACH ROW EXECUTE FUNCTION exom_queue_aggregate_catalog();
CREATE TRIGGER durable_aggregate_plan_training AFTER INSERT OR UPDATE OR DELETE ON plan_assignment_trainings FOR EACH ROW EXECUTE FUNCTION exom_queue_aggregate_catalog();
CREATE TRIGGER durable_aggregate_training AFTER UPDATE OR DELETE ON trainings FOR EACH ROW EXECUTE FUNCTION exom_queue_aggregate_catalog();
CREATE TRIGGER durable_aggregate_challenge_catalog AFTER UPDATE OR DELETE ON challenges FOR EACH ROW EXECUTE FUNCTION exom_queue_aggregate_catalog();

-- A catalog invalidation dominates any scoped work already queued in this tx.
CREATE OR REPLACE FUNCTION exom_queue_achievement_catalog() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.criteria_type IS NOT DISTINCT FROM OLD.criteria_type
    AND NEW.criteria_value IS NOT DISTINCT FROM OLD.criteria_value
    AND NEW.rule_config IS NOT DISTINCT FROM OLD.rule_config THEN RETURN NEW; END IF;
  IF NEW.criteria_type='CUSTOM' THEN
    DELETE FROM user_achievements WHERE achievement_id=NEW.id AND unlock_source='AUTOMATIC';
    RETURN NEW;
  END IF;
  INSERT INTO durable_work(key,kind,payload,owner_id)
    SELECT 'reconcile:' || id || ':' || txid_current()::text,'RECONCILE','{}',id FROM users WHERE role='CLIENT'
    ON CONFLICT(key) DO UPDATE SET payload='{}';
  RETURN NEW;
END $$;
