-- PlanAssignmentTraining is authoritative. Keep the deployed training_id
-- compatibility field equal to the first ordered link, including writes made
-- outside AssignmentsService.
CREATE OR REPLACE FUNCTION "sync_plan_assignment_training_id"()
RETURNS TRIGGER AS $$
DECLARE
  target_assignment_id TEXT;
  first_training_id TEXT;
BEGIN
  target_assignment_id := CASE
    WHEN TG_OP = 'DELETE' THEN OLD."assignment_id"
    ELSE NEW."assignment_id"
  END;

  -- Serialize child writers before calculating the first link. Lock both
  -- parents in stable order when a link is moved between assignments.
  IF TG_OP = 'UPDATE' AND OLD."assignment_id" IS DISTINCT FROM NEW."assignment_id" THEN
    PERFORM 1
      FROM "plan_assignments"
     WHERE "id" IN (OLD."assignment_id", NEW."assignment_id")
     ORDER BY "id"
     FOR NO KEY UPDATE;
  ELSE
    PERFORM 1
      FROM "plan_assignments"
     WHERE "id" = target_assignment_id
     FOR NO KEY UPDATE;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD."assignment_id" IS DISTINCT FROM NEW."assignment_id" THEN
    SELECT link."training_id"
      INTO first_training_id
      FROM "plan_assignment_trainings" AS link
     WHERE link."assignment_id" = OLD."assignment_id"
     ORDER BY link."position", link."id"
     LIMIT 1;

    UPDATE "plan_assignments"
       SET "training_id" = first_training_id
     WHERE "id" = OLD."assignment_id"
       AND "training_id" IS DISTINCT FROM first_training_id;
  END IF;

  SELECT link."training_id"
    INTO first_training_id
    FROM "plan_assignment_trainings" AS link
   WHERE link."assignment_id" = target_assignment_id
   ORDER BY link."position", link."id"
   LIMIT 1;

  UPDATE "plan_assignments"
     SET "training_id" = first_training_id
   WHERE "id" = target_assignment_id
     AND "training_id" IS DISTINCT FROM first_training_id;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "plan_assignment_trainings_sync_legacy_training_id"
AFTER INSERT OR UPDATE OR DELETE ON "plan_assignment_trainings"
FOR EACH ROW EXECUTE FUNCTION "sync_plan_assignment_training_id"();

CREATE OR REPLACE FUNCTION "enforce_plan_assignment_training_id"()
RETURNS TRIGGER AS $$
DECLARE
  first_training_id TEXT;
BEGIN
  PERFORM 1
    FROM "plan_assignments"
   WHERE "id" = NEW."id"
   FOR NO KEY UPDATE;

  SELECT link."training_id"
    INTO first_training_id
    FROM "plan_assignment_trainings" AS link
   WHERE link."assignment_id" = NEW."id"
   ORDER BY link."position", link."id"
   LIMIT 1;

  -- A missing link means a genuine legacy-only row; preserve its mirror.
  IF first_training_id IS NOT NULL
     AND NEW."training_id" IS DISTINCT FROM first_training_id THEN
    UPDATE "plan_assignments"
       SET "training_id" = first_training_id
     WHERE "id" = NEW."id"
       AND "training_id" IS DISTINCT FROM first_training_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "plan_assignments_enforce_legacy_training_id"
AFTER INSERT OR UPDATE ON "plan_assignments"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "enforce_plan_assignment_training_id"();

-- AutoAssignmentRuleDayTraining is likewise authoritative for rule templates.
CREATE OR REPLACE FUNCTION "sync_auto_assignment_rule_day_training_id"()
RETURNS TRIGGER AS $$
DECLARE
  target_rule_day_id TEXT;
  first_training_id TEXT;
BEGIN
  target_rule_day_id := CASE
    WHEN TG_OP = 'DELETE' THEN OLD."rule_day_id"
    ELSE NEW."rule_day_id"
  END;

  IF TG_OP = 'UPDATE' AND OLD."rule_day_id" IS DISTINCT FROM NEW."rule_day_id" THEN
    PERFORM 1
      FROM "auto_assignment_rule_days"
     WHERE "id" IN (OLD."rule_day_id", NEW."rule_day_id")
     ORDER BY "id"
     FOR NO KEY UPDATE;
  ELSE
    PERFORM 1
      FROM "auto_assignment_rule_days"
     WHERE "id" = target_rule_day_id
     FOR NO KEY UPDATE;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD."rule_day_id" IS DISTINCT FROM NEW."rule_day_id" THEN
    SELECT link."training_id"
      INTO first_training_id
      FROM "auto_assignment_rule_day_trainings" AS link
     WHERE link."rule_day_id" = OLD."rule_day_id"
     ORDER BY link."position", link."id"
     LIMIT 1;

    UPDATE "auto_assignment_rule_days"
       SET "training_id" = first_training_id
     WHERE "id" = OLD."rule_day_id"
       AND "training_id" IS DISTINCT FROM first_training_id;
  END IF;

  SELECT link."training_id"
    INTO first_training_id
    FROM "auto_assignment_rule_day_trainings" AS link
   WHERE link."rule_day_id" = target_rule_day_id
   ORDER BY link."position", link."id"
   LIMIT 1;

  UPDATE "auto_assignment_rule_days"
     SET "training_id" = first_training_id
   WHERE "id" = target_rule_day_id
     AND "training_id" IS DISTINCT FROM first_training_id;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "auto_assignment_rule_day_trainings_sync_legacy_training_id"
AFTER INSERT OR UPDATE OR DELETE ON "auto_assignment_rule_day_trainings"
FOR EACH ROW EXECUTE FUNCTION "sync_auto_assignment_rule_day_training_id"();

CREATE OR REPLACE FUNCTION "enforce_auto_assignment_rule_day_training_id"()
RETURNS TRIGGER AS $$
DECLARE
  first_training_id TEXT;
BEGIN
  PERFORM 1
    FROM "auto_assignment_rule_days"
   WHERE "id" = NEW."id"
   FOR NO KEY UPDATE;

  SELECT link."training_id"
    INTO first_training_id
    FROM "auto_assignment_rule_day_trainings" AS link
   WHERE link."rule_day_id" = NEW."id"
   ORDER BY link."position", link."id"
   LIMIT 1;

  IF first_training_id IS NOT NULL
     AND NEW."training_id" IS DISTINCT FROM first_training_id THEN
    UPDATE "auto_assignment_rule_days"
       SET "training_id" = first_training_id
     WHERE "id" = NEW."id"
       AND "training_id" IS DISTINCT FROM first_training_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "auto_assignment_rule_days_enforce_legacy_training_id"
AFTER INSERT OR UPDATE ON "auto_assignment_rule_days"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "enforce_auto_assignment_rule_day_training_id"();

-- Repair only rows that already have authoritative links. Legacy-only rows
-- remain readable through the documented fallback.
WITH first_links AS (
  SELECT DISTINCT ON (link."assignment_id")
    link."assignment_id",
    link."training_id"
  FROM "plan_assignment_trainings" AS link
  ORDER BY link."assignment_id", link."position", link."id"
)
UPDATE "plan_assignments" AS assignment
   SET "training_id" = first_links."training_id"
  FROM first_links
 WHERE assignment."id" = first_links."assignment_id"
   AND assignment."training_id" IS DISTINCT FROM first_links."training_id";

WITH first_links AS (
  SELECT DISTINCT ON (link."rule_day_id")
    link."rule_day_id",
    link."training_id"
  FROM "auto_assignment_rule_day_trainings" AS link
  ORDER BY link."rule_day_id", link."position", link."id"
)
UPDATE "auto_assignment_rule_days" AS rule_day
   SET "training_id" = first_links."training_id"
  FROM first_links
 WHERE rule_day."id" = first_links."rule_day_id"
   AND rule_day."training_id" IS DISTINCT FROM first_links."training_id";
