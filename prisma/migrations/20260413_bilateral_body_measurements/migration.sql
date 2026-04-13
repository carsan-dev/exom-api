ALTER TABLE "body_metrics"
ADD COLUMN "arm_left_cm" DOUBLE PRECISION,
ADD COLUMN "arm_right_cm" DOUBLE PRECISION,
ADD COLUMN "forearm_left_cm" DOUBLE PRECISION,
ADD COLUMN "forearm_right_cm" DOUBLE PRECISION,
ADD COLUMN "thigh_left_cm" DOUBLE PRECISION,
ADD COLUMN "thigh_right_cm" DOUBLE PRECISION,
ADD COLUMN "calf_left_cm" DOUBLE PRECISION,
ADD COLUMN "calf_right_cm" DOUBLE PRECISION;

UPDATE "body_metrics"
SET
  "arm_left_cm" = "arm_cm",
  "arm_right_cm" = "arm_cm",
  "forearm_left_cm" = "forearm_cm",
  "forearm_right_cm" = "forearm_cm",
  "thigh_left_cm" = "thigh_cm",
  "thigh_right_cm" = "thigh_cm",
  "calf_left_cm" = "calf_cm",
  "calf_right_cm" = "calf_cm";

ALTER TABLE "body_metrics"
DROP COLUMN "arm_cm",
DROP COLUMN "forearm_cm",
DROP COLUMN "thigh_cm",
DROP COLUMN "calf_cm";
