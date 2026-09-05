CREATE TYPE "TrainingMeasureType" AS ENUM ('REPS', 'SECONDS');

ALTER TABLE "training_exercises"
ADD COLUMN "measure_type" "TrainingMeasureType",
ADD COLUMN "target_value" INTEGER,
ADD COLUMN "target_rir" INTEGER;

UPDATE "training_exercises"
SET
  "measure_type" = 'SECONDS',
  "target_value" = (regexp_match("reps_or_duration", '^\s*([0-9]+)\s*(?:s|seg|sec|segundo(?:s)?|second(?:s)?)\s*$', 'i'))[1]::INTEGER
WHERE "reps_or_duration" ~* '^\s*[0-9]+\s*(?:s|seg|sec|segundo(?:s)?|second(?:s)?)\s*$'
  AND CASE
    WHEN length((regexp_match("reps_or_duration", '^\s*([0-9]+)', 'i'))[1]) <= 10
      THEN (regexp_match("reps_or_duration", '^\s*([0-9]+)', 'i'))[1]::BIGINT
    ELSE NULL
  END BETWEEN 1 AND 2147483647;

UPDATE "training_exercises"
SET
  "measure_type" = 'SECONDS',
  "target_value" = (regexp_match("reps_or_duration", '^\s*([0-9]+)\s*(?:min|mins|minute(?:s)?|minuto(?:s)?)\s*$', 'i'))[1]::INTEGER * 60
WHERE "measure_type" IS NULL
  AND "reps_or_duration" ~* '^\s*[0-9]+\s*(?:min|mins|minute(?:s)?|minuto(?:s)?)\s*$'
  AND CASE
    WHEN length((regexp_match("reps_or_duration", '^\s*([0-9]+)', 'i'))[1]) <= 10
      THEN (regexp_match("reps_or_duration", '^\s*([0-9]+)', 'i'))[1]::BIGINT
    ELSE NULL
  END BETWEEN 1 AND 35791394;

UPDATE "training_exercises"
SET
  "measure_type" = 'REPS',
  "target_value" = (regexp_match("reps_or_duration", '^\s*([0-9]+)\s*(?:rep(?:s|eticiones?)?)?\s*$', 'i'))[1]::INTEGER
WHERE "measure_type" IS NULL
  AND "reps_or_duration" ~* '^\s*[0-9]+\s*(?:rep(?:s|eticiones?)?)?\s*$'
  AND CASE
    WHEN length((regexp_match("reps_or_duration", '^\s*([0-9]+)', 'i'))[1]) <= 10
      THEN (regexp_match("reps_or_duration", '^\s*([0-9]+)', 'i'))[1]::BIGINT
    ELSE NULL
  END BETWEEN 1 AND 2147483647;

ALTER TABLE "training_exercises"
ADD CONSTRAINT "training_exercises_measure_target_pair_check"
CHECK (("measure_type" IS NULL) = ("target_value" IS NULL)),
ADD CONSTRAINT "training_exercises_target_value_check"
CHECK ("target_value" IS NULL OR "target_value" >= 1),
ADD CONSTRAINT "training_exercises_target_rir_check"
CHECK ("target_rir" IS NULL OR "target_rir" BETWEEN 0 AND 10);
