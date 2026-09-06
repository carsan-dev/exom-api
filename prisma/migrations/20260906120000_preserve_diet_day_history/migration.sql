-- Content history, not another editable catalog. UTC matches date-only commands.
-- Lock order: catalog barrier (exclusive for catalog, shared for planning/progress),
-- then client advisory, then user/assignment/progress row locks. Statement triggers
-- take the barrier BEFORE acquiring any catalog row lock, including old clients/SQL.
BEGIN;

CREATE TABLE "diet_day_snapshots" (
  "client_id" TEXT NOT NULL,
  "date" DATE NOT NULL,
  "diet_id" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" = 1),
  "provenance" TEXT NOT NULL CHECK ("provenance" IN ('observed', 'legacy_available')),
  "captured_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "diet" JSONB NOT NULL CHECK (jsonb_typeof("diet") = 'object'),
  PRIMARY KEY ("client_id", "date", "diet_id"),
  FOREIGN KEY ("client_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE FUNCTION exom_diet_history_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_ARGV[0] = 'catalog' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('exom:diet-history', 0));
  ELSE
    PERFORM pg_advisory_xact_lock_shared(hashtextextended('exom:diet-history', 0));
  END IF;
  RETURN NULL;
END $$;

-- Catalog mutation capture locates only assignments of the affected diet.
CREATE INDEX "plan_assignments_diet_id_date_client_id_idx"
  ON "plan_assignments"("diet_id", "date", "client_id");

CREATE FUNCTION exom_diet_history_protected(p_client TEXT, p_date DATE)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT p_date < (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date OR EXISTS (
    SELECT 1 FROM day_progress p WHERE p.client_id = p_client AND p.date = p_date
      AND (p.training_completed OR cardinality(p.trainings_completed) > 0
        OR p.exercises_completed <> '[]'::jsonb OR cardinality(p.meals_completed) > 0
        OR NULLIF(btrim(p.notes), '') IS NOT NULL)
  );
$$;

-- Shape is the existing dietInclude API contract (main meals + ordered variants).
CREATE FUNCTION exom_diet_history_meal(p_meal meals) RETURNS JSONB
LANGUAGE sql STABLE AS $$
  SELECT to_jsonb(p_meal) || jsonb_build_object('ingredients', COALESCE((
    SELECT jsonb_agg(to_jsonb(mi) || jsonb_build_object('ingredient', to_jsonb(i)) ORDER BY mi.id)
    FROM meal_ingredients mi JOIN ingredients i ON i.id = mi.ingredient_id
    WHERE mi.meal_id = p_meal.id
  ), '[]'::jsonb));
$$;

CREATE FUNCTION exom_capture_diet_day(p_client TEXT, p_date DATE, p_diet TEXT,
  p_provenance TEXT DEFAULT 'observed') RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_diet IS NULL OR NOT exom_diet_history_protected(p_client, p_date)
    OR NOT EXISTS (SELECT 1 FROM users WHERE id = p_client)
    OR EXISTS (SELECT 1 FROM diet_day_snapshots
      WHERE client_id = p_client AND date = p_date AND diet_id = p_diet) THEN
    RETURN;
  END IF;
  INSERT INTO diet_day_snapshots (client_id, date, diet_id, provenance, diet)
  SELECT p_client, p_date, d.id, p_provenance, to_jsonb(d) || jsonb_build_object(
    'group', (SELECT jsonb_build_object('id', g.id, 'name', g.name) FROM diet_groups g WHERE g.id = d.group_id),
    'meals', COALESCE((SELECT jsonb_agg(exom_diet_history_meal(m) || jsonb_build_object(
      'variants', COALESCE((SELECT jsonb_agg(exom_diet_history_meal(v) ORDER BY v."order", v.id)
        FROM meals v WHERE v.parent_meal_id = m.id), '[]'::jsonb)
    ) ORDER BY m."order", m.id) FROM meals m WHERE m.diet_id = d.id AND m.parent_meal_id IS NULL), '[]'::jsonb)
  ) FROM diets d WHERE d.id = p_diet
  ON CONFLICT (client_id, date, diet_id) DO NOTHING;
END $$;

CREATE FUNCTION exom_capture_diet_assignments(p_diet TEXT) RETURNS void LANGUAGE plpgsql AS $$
DECLARE a RECORD;
BEGIN
  FOR a IN SELECT client_id, date FROM plan_assignments WHERE diet_id = p_diet LOOP
    PERFORM exom_capture_diet_day(a.client_id, a.date, p_diet);
  END LOOP;
END $$;

CREATE FUNCTION exom_snapshot_catalog_before_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target RECORD;
BEGIN
  IF TG_TABLE_NAME = 'diets' THEN
    IF TG_OP <> 'INSERT' THEN PERFORM exom_capture_diet_assignments(OLD.id); END IF;
  ELSIF TG_TABLE_NAME = 'meals' THEN
    IF TG_OP <> 'INSERT' THEN PERFORM exom_capture_diet_assignments(OLD.diet_id); END IF;
    IF TG_OP <> 'DELETE' THEN PERFORM exom_capture_diet_assignments(NEW.diet_id); END IF;
  ELSIF TG_TABLE_NAME = 'meal_ingredients' THEN
    FOR target IN SELECT DISTINCT diet_id FROM meals
      WHERE id IN (CASE WHEN TG_OP <> 'INSERT' THEN OLD.meal_id END,
                   CASE WHEN TG_OP <> 'DELETE' THEN NEW.meal_id END) LOOP
      PERFORM exom_capture_diet_assignments(target.diet_id);
    END LOOP;
  ELSIF TG_TABLE_NAME = 'ingredients' AND TG_OP <> 'INSERT' THEN
    FOR target IN SELECT DISTINCT m.diet_id FROM meals m JOIN meal_ingredients mi ON mi.meal_id = m.id
      WHERE mi.ingredient_id = OLD.id LOOP
      PERFORM exom_capture_diet_assignments(target.diet_id);
    END LOOP;
  ELSIF TG_TABLE_NAME = 'diet_groups' AND TG_OP <> 'INSERT' THEN
    FOR target IN SELECT id AS diet_id FROM diets WHERE group_id = OLD.id LOOP
      PERFORM exom_capture_diet_assignments(target.diet_id);
    END LOOP;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;

CREATE FUNCTION exom_snapshot_assignment_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM exom_capture_diet_day(NEW.client_id, NEW.date, NEW.diet_id);
  RETURN NEW;
END $$;
-- Separate BEFORE wrapper to preserve the actual manual update, including null.
CREATE FUNCTION exom_snapshot_assignment_before_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM exom_capture_diet_day(OLD.client_id, OLD.date, OLD.diet_id);
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;

CREATE FUNCTION exom_snapshot_progress_after_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE assigned_diet TEXT;
BEGIN
  SELECT diet_id INTO assigned_diet FROM plan_assignments WHERE client_id = NEW.client_id AND date = NEW.date;
  PERFORM exom_capture_diet_day(NEW.client_id, NEW.date, assigned_diet);
  RETURN NEW;
END $$;

CREATE FUNCTION exom_immutable_diet_day_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Only the owning user's FK cascade may discard content. Catalog cascades cannot.
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM users WHERE id = OLD.client_id) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Diet day snapshots are immutable' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER immutable_diet_day_snapshot BEFORE UPDATE OR DELETE ON diet_day_snapshots
  FOR EACH ROW EXECUTE FUNCTION exom_immutable_diet_day_snapshot();

DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['diets', 'meals', 'meal_ingredients', 'ingredients', 'diet_groups'] LOOP
    EXECUTE format('CREATE TRIGGER diet_history_barrier BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH STATEMENT EXECUTE FUNCTION exom_diet_history_barrier(''catalog'')', t);
    EXECUTE format('CREATE TRIGGER diet_history_content BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION exom_snapshot_catalog_before_change()', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['plan_assignments', 'day_progress'] LOOP
    EXECUTE format('CREATE TRIGGER diet_history_barrier BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH STATEMENT EXECUTE FUNCTION exom_diet_history_barrier(''consumer'')', t);
  END LOOP;
END $$;
CREATE TRIGGER diet_history_assignment_before BEFORE UPDATE OR DELETE ON plan_assignments
  FOR EACH ROW EXECUTE FUNCTION exom_snapshot_assignment_before_change();
CREATE TRIGGER diet_history_assignment_after AFTER INSERT OR UPDATE ON plan_assignments
  FOR EACH ROW EXECUTE FUNCTION exom_snapshot_assignment_change();
CREATE TRIGGER diet_history_progress_after AFTER INSERT OR UPDATE ON day_progress
  FOR EACH ROW EXECUTE FUNCTION exom_snapshot_progress_after_change();

-- Backfill does NOT reconstruct previously deleted or edited content. Mark it so.
SELECT exom_capture_diet_day(client_id, date, diet_id, 'legacy_available')
FROM plan_assignments WHERE diet_id IS NOT NULL;

COMMIT;
