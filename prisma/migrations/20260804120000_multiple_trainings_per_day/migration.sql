-- Ordered trainings assigned to a calendar day (maximum 5 is enforced by the API).
CREATE TABLE "plan_assignment_trainings" (
  "id" TEXT NOT NULL,
  "assignment_id" TEXT NOT NULL,
  "training_id" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  CONSTRAINT "plan_assignment_trainings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "plan_assignment_trainings_assignment_id_training_id_key"
  ON "plan_assignment_trainings"("assignment_id", "training_id");
CREATE UNIQUE INDEX "plan_assignment_trainings_assignment_id_position_key"
  ON "plan_assignment_trainings"("assignment_id", "position");
CREATE INDEX "plan_assignment_trainings_training_id_idx"
  ON "plan_assignment_trainings"("training_id");

ALTER TABLE "plan_assignment_trainings"
  ADD CONSTRAINT "plan_assignment_trainings_assignment_id_fkey"
  FOREIGN KEY ("assignment_id") REFERENCES "plan_assignments"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "plan_assignment_trainings"
  ADD CONSTRAINT "plan_assignment_trainings_training_id_fkey"
  FOREIGN KEY ("training_id") REFERENCES "trainings"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "auto_assignment_rule_day_trainings" (
  "id" TEXT NOT NULL,
  "rule_day_id" TEXT NOT NULL,
  "training_id" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  CONSTRAINT "auto_assignment_rule_day_trainings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "auto_assignment_rule_day_trainings_rule_day_id_training_id_key"
  ON "auto_assignment_rule_day_trainings"("rule_day_id", "training_id");
CREATE UNIQUE INDEX "auto_assignment_rule_day_trainings_rule_day_id_position_key"
  ON "auto_assignment_rule_day_trainings"("rule_day_id", "position");
CREATE INDEX "auto_assignment_rule_day_trainings_training_id_idx"
  ON "auto_assignment_rule_day_trainings"("training_id");

ALTER TABLE "auto_assignment_rule_day_trainings"
  ADD CONSTRAINT "auto_assignment_rule_day_trainings_rule_day_id_fkey"
  FOREIGN KEY ("rule_day_id") REFERENCES "auto_assignment_rule_days"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "auto_assignment_rule_day_trainings"
  ADD CONSTRAINT "auto_assignment_rule_day_trainings_training_id_fkey"
  FOREIGN KEY ("training_id") REFERENCES "trainings"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "plan_assignment_trainings" ("id", "assignment_id", "training_id", "position")
SELECT gen_random_uuid()::text, "id", "training_id", 0
FROM "plan_assignments"
WHERE "training_id" IS NOT NULL;

INSERT INTO "auto_assignment_rule_day_trainings" ("id", "rule_day_id", "training_id", "position")
SELECT gen_random_uuid()::text, "id", "training_id", 0
FROM "auto_assignment_rule_days"
WHERE "training_id" IS NOT NULL;

ALTER TABLE "day_progress"
  ADD COLUMN "trainings_completed" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

UPDATE "day_progress" AS progress
SET "trainings_completed" = ARRAY[assignment."training_id"]::TEXT[]
FROM "plan_assignments" AS assignment
WHERE progress."client_id" = assignment."client_id"
  AND progress."date" = assignment."date"
  AND progress."training_completed" = true
  AND assignment."training_id" IS NOT NULL;

-- The legacy training_id columns remain as a temporary mirror for deployed
-- clients and are populated with the first ordered training by the API.
