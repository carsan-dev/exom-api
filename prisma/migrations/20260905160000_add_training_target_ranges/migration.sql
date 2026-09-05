ALTER TABLE "training_exercises"
ADD COLUMN "target_value_min" INTEGER,
ADD COLUMN "target_value_max" INTEGER;

ALTER TABLE "training_exercises"
DROP CONSTRAINT "training_exercises_measure_target_pair_check";

WITH candidates AS (
  SELECT
    "id",
    regexp_match(
      "reps_or_duration",
      '^\s*([0-9]+)\s*-\s*([0-9]+)\s*(?:s|seg|sec|segundo(?:s)?|second(?:s)?)\s*$',
      'i'
    ) AS parts
  FROM "training_exercises"
  WHERE "measure_type" IS NULL
    AND "reps_or_duration" ~* '^\s*[0-9]+\s*-\s*[0-9]+\s*(?:s|seg|sec|segundo(?:s)?|second(?:s)?)\s*$'
), bounded AS (
  SELECT
    "id",
    CASE WHEN length(parts[1]) <= 10 THEN parts[1]::BIGINT END AS target_min,
    CASE WHEN length(parts[2]) <= 10 THEN parts[2]::BIGINT END AS target_max
  FROM candidates
)
UPDATE "training_exercises" AS exercise
SET
  "measure_type" = 'SECONDS',
  "target_value_min" = bounded.target_min::INTEGER,
  "target_value_max" = bounded.target_max::INTEGER
FROM bounded
WHERE exercise."id" = bounded."id"
  AND bounded.target_min BETWEEN 1 AND 2147483647
  AND bounded.target_max BETWEEN 1 AND 2147483647
  AND bounded.target_min <= bounded.target_max;

WITH candidates AS (
  SELECT
    "id",
    regexp_match(
      "reps_or_duration",
      '^\s*([0-9]+)\s*-\s*([0-9]+)\s*(?:rep(?:s|eticiones?)?)?\s*$',
      'i'
    ) AS parts
  FROM "training_exercises"
  WHERE "measure_type" IS NULL
    AND "reps_or_duration" ~* '^\s*[0-9]+\s*-\s*[0-9]+\s*(?:rep(?:s|eticiones?)?)?\s*$'
), bounded AS (
  SELECT
    "id",
    CASE WHEN length(parts[1]) <= 10 THEN parts[1]::BIGINT END AS target_min,
    CASE WHEN length(parts[2]) <= 10 THEN parts[2]::BIGINT END AS target_max
  FROM candidates
)
UPDATE "training_exercises" AS exercise
SET
  "measure_type" = 'REPS',
  "target_value_min" = bounded.target_min::INTEGER,
  "target_value_max" = bounded.target_max::INTEGER
FROM bounded
WHERE exercise."id" = bounded."id"
  AND bounded.target_min BETWEEN 1 AND 2147483647
  AND bounded.target_max BETWEEN 1 AND 2147483647
  AND bounded.target_min <= bounded.target_max;

ALTER TABLE "training_exercises"
ADD CONSTRAINT "training_exercises_target_value_min_check"
CHECK ("target_value_min" IS NULL OR "target_value_min" >= 1),
ADD CONSTRAINT "training_exercises_target_value_max_check"
CHECK ("target_value_max" IS NULL OR "target_value_max" >= 1),
ADD CONSTRAINT "training_exercises_target_shape_check"
CHECK (
  (
    "measure_type" IS NULL
    AND "target_value" IS NULL
    AND "target_value_min" IS NULL
    AND "target_value_max" IS NULL
  )
  OR
  (
    "measure_type" IS NOT NULL
    AND (
      (
        "target_value" IS NOT NULL
        AND "target_value_min" IS NULL
        AND "target_value_max" IS NULL
      )
      OR
      (
        "target_value" IS NULL
        AND "target_value_min" IS NOT NULL
        AND "target_value_max" IS NOT NULL
        AND "target_value_min" <= "target_value_max"
      )
    )
  )
);
