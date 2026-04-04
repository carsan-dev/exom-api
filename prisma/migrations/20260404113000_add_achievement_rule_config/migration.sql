ALTER TABLE "achievements"
ADD COLUMN "rule_config" JSONB;

UPDATE "achievements"
SET
  "criteria_type" = 'TRAINING_DAYS',
  "rule_config" = NULL
WHERE "criteria_type" = 'trainings_completed';

UPDATE "achievements"
SET
  "criteria_type" = 'STREAK_DAYS',
  "rule_config" = NULL
WHERE "criteria_type" = 'streak_days';

UPDATE "achievements"
SET
  "criteria_type" = 'TRAINING_DAYS',
  "rule_config" = jsonb_build_object('training_type', 'HIIT')
WHERE "criteria_type" = 'hiit_completed';

CREATE INDEX "achievements_criteria_type_idx" ON "achievements"("criteria_type");
