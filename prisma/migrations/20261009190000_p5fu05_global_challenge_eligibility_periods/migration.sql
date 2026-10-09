BEGIN;

-- Private provenance is ignored by Prisma payloads. Unknown legacy event times
-- remain unknown; the backfill baseline below preserves already attained credit.
ALTER TABLE "body_metrics" ADD COLUMN "challenge_activity_at" TIMESTAMPTZ(3) DEFAULT NULL;
ALTER TABLE "day_progress" ADD COLUMN "challenge_activity" JSONB NOT NULL DEFAULT '{}';

CREATE FUNCTION "record_metric_challenge_activity"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.weight_kg IS DISTINCT FROM OLD.weight_kg
      OR NEW.date IS DISTINCT FROM OLD.date THEN
    NEW.challenge_activity_at := CASE WHEN NEW.weight_kg IS NULL THEN NULL ELSE clock_timestamp() END;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "body_metrics_challenge_activity" BEFORE INSERT OR UPDATE OF weight_kg, date
  ON "body_metrics" FOR EACH ROW EXECUTE FUNCTION "record_metric_challenge_activity"();

CREATE FUNCTION "record_day_challenge_activity"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  stamp TEXT := to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  previous JSONB := '{}';
  meal TEXT;
  meals JSONB := '{}';
  exercise JSONB;
  identity JSONB;
  retained JSONB;
  matches INTEGER;
  exercises JSONB := '[]';
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.date = OLD.date THEN previous := OLD.challenge_activity; END IF;
  NEW.challenge_activity := previous;
  IF NEW.training_completed THEN
    IF TG_OP = 'INSERT' OR NOT OLD.training_completed OR NEW.date IS DISTINCT FROM OLD.date THEN
      NEW.challenge_activity := jsonb_set(NEW.challenge_activity, '{training}', to_jsonb(stamp));
    END IF;
  ELSE NEW.challenge_activity := NEW.challenge_activity - 'training'; END IF;
  IF jsonb_typeof(NEW.exercises_completed) = 'array' THEN
    FOR exercise IN SELECT value FROM jsonb_array_elements(NEW.exercises_completed) LOOP
      IF jsonb_typeof(exercise->'exercise_id') IS DISTINCT FROM 'string' THEN CONTINUE; END IF;
      identity := jsonb_build_array(exercise->>'exercise_id', exercise->>'training_exercise_id', exercise->>'training_session_id');
      matches := 0;
      IF TG_OP = 'UPDATE' AND NEW.date = OLD.date AND jsonb_typeof(OLD.exercises_completed) = 'array' THEN
        SELECT count(DISTINCT jsonb_build_array(value->>'exercise_id', value->>'training_exercise_id', value->>'training_session_id')),
          jsonb_agg(jsonb_build_array(value->>'exercise_id', value->>'training_exercise_id', value->>'training_session_id')
            ORDER BY jsonb_build_array(value->>'exercise_id', value->>'training_exercise_id', value->>'training_session_id') = identity DESC)->0
          INTO matches, retained FROM jsonb_array_elements(OLD.exercises_completed)
          WHERE jsonb_build_array(value->>'exercise_id', value->>'training_exercise_id', value->>'training_session_id') = identity
            OR (value->>'exercise_id' = exercise->>'exercise_id' AND value->>'training_exercise_id' IS NULL
              AND value->>'training_session_id' IS NOT DISTINCT FROM exercise->>'training_session_id');
        IF retained = identity THEN matches := 1; END IF;
      END IF;
      -- Undo, reorder and set edits retain each event; ambiguous legacy time stays unknown.
      IF matches = 0 THEN
        exercises := exercises || jsonb_build_array(jsonb_build_object('identity', identity, 'recorded_at', stamp));
      ELSIF matches = 1 THEN
        SELECT value->'recorded_at' INTO retained FROM jsonb_array_elements(COALESCE(previous->'exercises', '[]'))
          WHERE value->'identity' = retained LIMIT 1;
        IF retained IS NOT NULL THEN
          exercises := exercises || jsonb_build_array(jsonb_build_object('identity', identity, 'recorded_at', retained));
        END IF;
      END IF;
    END LOOP;
  END IF;
  NEW.challenge_activity := NEW.challenge_activity - 'exercise';
  IF jsonb_array_length(exercises) > 0 OR previous ? 'exercises' OR (TG_OP = 'UPDATE' AND CASE WHEN jsonb_typeof(OLD.exercises_completed) = 'array' THEN jsonb_array_length(OLD.exercises_completed) ELSE 0 END > 0) THEN
    NEW.challenge_activity := jsonb_set(NEW.challenge_activity, '{exercises}', exercises);
  END IF;
  FOREACH meal IN ARRAY COALESCE(NEW.meals_completed, ARRAY[]::TEXT[]) LOOP
    IF TG_OP = 'UPDATE' AND NEW.date = OLD.date AND meal = ANY(OLD.meals_completed) THEN
      IF previous->'meals' ? meal THEN meals := meals || jsonb_build_object(meal, previous->'meals'->meal); END IF;
    ELSE meals := meals || jsonb_build_object(meal, stamp); END IF;
  END LOOP;
  NEW.challenge_activity := jsonb_set(NEW.challenge_activity, '{meals}', meals);
  RETURN NEW;
END;
$$;
CREATE TRIGGER "day_progress_challenge_activity" BEFORE INSERT OR UPDATE OF training_completed, exercises_completed, meals_completed, date
  ON "day_progress" FOR EACH ROW EXECUTE FUNCTION "record_day_challenge_activity"();

CREATE TABLE "challenge_client_eligibility_periods" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "challenge_client_id" TEXT NOT NULL,
  "starts_on" DATE NOT NULL,
  "ends_on" DATE,
  "opened_at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
  "baseline_value" DOUBLE PRECISION NOT NULL DEFAULT 0,
  CONSTRAINT "challenge_client_eligibility_periods_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "challenge_client_eligibility_periods_challenge_client_id_fkey"
    FOREIGN KEY ("challenge_client_id") REFERENCES "challenge_clients"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "challenge_client_eligibility_periods_date_order_check"
    CHECK ("ends_on" IS NULL OR "ends_on" >= "starts_on")
);

CREATE INDEX "challenge_client_eligibility_periods_challenge_client_id_starts_on_idx"
  ON "challenge_client_eligibility_periods"("challenge_client_id", "starts_on");
CREATE UNIQUE INDEX "challenge_client_eligibility_periods_one_open_per_assignment"
  ON "challenge_client_eligibility_periods"("challenge_client_id") WHERE "ends_on" IS NULL;

CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE "challenge_client_eligibility_periods" ADD CONSTRAINT "challenge_client_eligibility_periods_no_overlap"
  EXCLUDE USING gist ("challenge_client_id" WITH =, daterange("starts_on", "ends_on", '[)') WITH &&);

-- Existing deleted rows cannot be reconstructed. Only rows currently eligible get a
-- known baseline, not reconstructed historical membership or mutation times.
INSERT INTO "challenge_client_eligibility_periods" ("challenge_client_id", "starts_on", "baseline_value")
SELECT cc."id", (clock_timestamp() AT TIME ZONE 'UTC')::date + 1, cc."current_value"
FROM "challenge_clients" cc
JOIN "challenges" c ON c."id" = cc."challenge_id"
JOIN "users" client ON client."id" = cc."client_id" AND client."role" = 'CLIENT'
LEFT JOIN "users" creator ON creator."id" = c."created_by"
WHERE c."is_global" = TRUE
  AND cc."assignment_source" = 'GLOBAL'
  AND (
    c."created_by" IS NULL
    OR (creator."role" = 'SUPER_ADMIN' AND EXISTS (
      SELECT 1 FROM "users" client
      WHERE client."id" = cc."client_id" AND client."role" = 'CLIENT'
    ))
    OR (creator."role" = 'ADMIN' AND EXISTS (
      SELECT 1 FROM "admin_client_assignments" aca
      WHERE aca."admin_id" = creator."id"
        AND aca."client_id" = cc."client_id"
        AND aca."is_active" = TRUE
    ))
  );

-- All scope writers (including role changes and SQL repair/replay) close the
-- same periods. Row-level serialization preserves the attained baseline.
CREATE FUNCTION "reconcile_global_challenge_eligibility"(affected_client TEXT, affected_creator TEXT)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  assignment RECORD;
  eligible BOOLEAN;
  today DATE := (clock_timestamp() AT TIME ZONE 'UTC')::date;
BEGIN
  FOR assignment IN SELECT cc.*, c.is_global, c.created_by FROM challenge_clients cc
    JOIN challenges c ON c.id = cc.challenge_id WHERE cc.assignment_source = 'GLOBAL'
      AND (affected_client IS NULL OR cc.client_id = affected_client)
      AND (affected_creator IS NULL OR c.created_by = affected_creator)
    ORDER BY cc.client_id, cc.id FOR UPDATE OF cc LOOP
    SELECT assignment.is_global AND client.role = 'CLIENT' AND
      (assignment.created_by IS NULL OR creator.role = 'SUPER_ADMIN' OR
        (creator.role = 'ADMIN' AND EXISTS (SELECT 1 FROM admin_client_assignments aca
          WHERE aca.admin_id = assignment.created_by AND aca.client_id = assignment.client_id AND aca.is_active)))
      INTO eligible FROM users client LEFT JOIN users creator ON creator.id = assignment.created_by
      WHERE client.id = assignment.client_id;
    IF COALESCE(eligible, false) THEN
      INSERT INTO challenge_client_eligibility_periods(challenge_client_id,starts_on,baseline_value)
        SELECT assignment.id,today+1,assignment.current_value WHERE NOT EXISTS
          (SELECT 1 FROM challenge_client_eligibility_periods WHERE challenge_client_id = assignment.id AND ends_on IS NULL)
        ON CONFLICT DO NOTHING;
    ELSE
      UPDATE challenge_client_eligibility_periods SET ends_on = GREATEST(starts_on,today)
        WHERE challenge_client_id = assignment.id AND ends_on IS NULL;
    END IF;
  END LOOP;
END;
$$;
CREATE FUNCTION "scope_global_challenge_eligibility"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'admin_client_assignments' THEN
    IF TG_OP <> 'INSERT' THEN PERFORM reconcile_global_challenge_eligibility(OLD.client_id,OLD.admin_id); END IF;
    IF TG_OP <> 'DELETE' THEN PERFORM reconcile_global_challenge_eligibility(NEW.client_id,NEW.admin_id); END IF;
  ELSIF TG_TABLE_NAME = 'users' THEN
    PERFORM reconcile_global_challenge_eligibility(NULL,NEW.id);
    PERFORM reconcile_global_challenge_eligibility(NEW.id,NULL);
  ELSE
    PERFORM reconcile_global_challenge_eligibility(NULL,OLD.created_by);
    IF NEW.created_by IS DISTINCT FROM OLD.created_by THEN PERFORM reconcile_global_challenge_eligibility(NULL,NEW.created_by); END IF;
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER "admin_client_assignments_challenge_eligibility" AFTER INSERT OR DELETE OR UPDATE OF is_active,admin_id,client_id
  ON admin_client_assignments FOR EACH ROW EXECUTE FUNCTION scope_global_challenge_eligibility();
CREATE TRIGGER "users_challenge_eligibility" AFTER UPDATE OF role ON users
  FOR EACH ROW WHEN (OLD.role IS DISTINCT FROM NEW.role) EXECUTE FUNCTION scope_global_challenge_eligibility();
CREATE TRIGGER "challenges_scope_eligibility" AFTER UPDATE OF is_global,created_by ON challenges
  FOR EACH ROW WHEN (OLD.is_global IS DISTINCT FROM NEW.is_global OR OLD.created_by IS DISTINCT FROM NEW.created_by)
  EXECUTE FUNCTION scope_global_challenge_eligibility();

COMMIT;
