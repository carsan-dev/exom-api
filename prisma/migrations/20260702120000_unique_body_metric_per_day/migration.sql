WITH ranked AS (
  SELECT
    "id",
    "client_id",
    "date",
    ROW_NUMBER() OVER (
      PARTITION BY "client_id", "date"
      ORDER BY "created_at" DESC, "id" DESC
    ) AS row_number
  FROM "body_metrics"
), merged AS (
  SELECT
    "client_id",
    "date",
    (ARRAY_AGG("weight_kg" ORDER BY "created_at" DESC, "id" DESC) FILTER (WHERE "weight_kg" IS NOT NULL))[1] AS "weight_kg",
    (ARRAY_AGG("muscle_mass_kg" ORDER BY "created_at" DESC, "id" DESC) FILTER (WHERE "muscle_mass_kg" IS NOT NULL))[1] AS "muscle_mass_kg",
    (ARRAY_AGG("height_cm" ORDER BY "created_at" DESC, "id" DESC) FILTER (WHERE "height_cm" IS NOT NULL))[1] AS "height_cm",
    (ARRAY_AGG("sleep_hours" ORDER BY "created_at" DESC, "id" DESC) FILTER (WHERE "sleep_hours" IS NOT NULL))[1] AS "sleep_hours",
    (ARRAY_AGG("neck_cm" ORDER BY "created_at" DESC, "id" DESC) FILTER (WHERE "neck_cm" IS NOT NULL))[1] AS "neck_cm",
    (ARRAY_AGG("shoulders_cm" ORDER BY "created_at" DESC, "id" DESC) FILTER (WHERE "shoulders_cm" IS NOT NULL))[1] AS "shoulders_cm",
    (ARRAY_AGG("chest_cm" ORDER BY "created_at" DESC, "id" DESC) FILTER (WHERE "chest_cm" IS NOT NULL))[1] AS "chest_cm",
    (ARRAY_AGG("arm_left_cm" ORDER BY "created_at" DESC, "id" DESC) FILTER (WHERE "arm_left_cm" IS NOT NULL))[1] AS "arm_left_cm",
    (ARRAY_AGG("arm_right_cm" ORDER BY "created_at" DESC, "id" DESC) FILTER (WHERE "arm_right_cm" IS NOT NULL))[1] AS "arm_right_cm",
    (ARRAY_AGG("forearm_left_cm" ORDER BY "created_at" DESC, "id" DESC) FILTER (WHERE "forearm_left_cm" IS NOT NULL))[1] AS "forearm_left_cm",
    (ARRAY_AGG("forearm_right_cm" ORDER BY "created_at" DESC, "id" DESC) FILTER (WHERE "forearm_right_cm" IS NOT NULL))[1] AS "forearm_right_cm",
    (ARRAY_AGG("waist_cm" ORDER BY "created_at" DESC, "id" DESC) FILTER (WHERE "waist_cm" IS NOT NULL))[1] AS "waist_cm",
    (ARRAY_AGG("hips_cm" ORDER BY "created_at" DESC, "id" DESC) FILTER (WHERE "hips_cm" IS NOT NULL))[1] AS "hips_cm",
    (ARRAY_AGG("thigh_left_cm" ORDER BY "created_at" DESC, "id" DESC) FILTER (WHERE "thigh_left_cm" IS NOT NULL))[1] AS "thigh_left_cm",
    (ARRAY_AGG("thigh_right_cm" ORDER BY "created_at" DESC, "id" DESC) FILTER (WHERE "thigh_right_cm" IS NOT NULL))[1] AS "thigh_right_cm",
    (ARRAY_AGG("calf_left_cm" ORDER BY "created_at" DESC, "id" DESC) FILTER (WHERE "calf_left_cm" IS NOT NULL))[1] AS "calf_left_cm",
    (ARRAY_AGG("calf_right_cm" ORDER BY "created_at" DESC, "id" DESC) FILTER (WHERE "calf_right_cm" IS NOT NULL))[1] AS "calf_right_cm"
  FROM "body_metrics"
  GROUP BY "client_id", "date"
  HAVING COUNT(*) > 1
)
UPDATE "body_metrics" AS keeper
SET
  "weight_kg" = merged."weight_kg",
  "muscle_mass_kg" = merged."muscle_mass_kg",
  "height_cm" = merged."height_cm",
  "sleep_hours" = merged."sleep_hours",
  "neck_cm" = merged."neck_cm",
  "shoulders_cm" = merged."shoulders_cm",
  "chest_cm" = merged."chest_cm",
  "arm_left_cm" = merged."arm_left_cm",
  "arm_right_cm" = merged."arm_right_cm",
  "forearm_left_cm" = merged."forearm_left_cm",
  "forearm_right_cm" = merged."forearm_right_cm",
  "waist_cm" = merged."waist_cm",
  "hips_cm" = merged."hips_cm",
  "thigh_left_cm" = merged."thigh_left_cm",
  "thigh_right_cm" = merged."thigh_right_cm",
  "calf_left_cm" = merged."calf_left_cm",
  "calf_right_cm" = merged."calf_right_cm"
FROM ranked
JOIN merged
  ON merged."client_id" = ranked."client_id"
  AND merged."date" = ranked."date"
WHERE keeper."id" = ranked."id" AND ranked.row_number = 1;

WITH ranked AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "client_id", "date"
      ORDER BY "created_at" DESC, "id" DESC
    ) AS row_number
  FROM "body_metrics"
)
DELETE FROM "body_metrics"
USING ranked
WHERE "body_metrics"."id" = ranked."id" AND ranked.row_number > 1;

CREATE UNIQUE INDEX "body_metrics_client_id_date_key"
ON "body_metrics"("client_id", "date");
