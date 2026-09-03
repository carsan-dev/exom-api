-- Feedback submitted for the final set of an assigned exercise.
CREATE TYPE "FeedbackKind" AS ENUM ('GENERAL', 'LAST_SET');
CREATE TYPE "LastSetVideoPolicy" AS ENUM ('AUTO', 'ALWAYS', 'NEVER');
CREATE TYPE "ManagedUploadPurpose" AS ENUM (
  'AVATAR',
  'FEEDBACK_IMAGE',
  'FEEDBACK_VIDEO',
  'EXERCISE_VIDEO',
  'EXERCISE_THUMBNAIL',
  'MEAL_IMAGE'
);
CREATE TYPE "ManagedUploadStatus" AS ENUM ('PENDING', 'VERIFIED', 'RESERVED', 'CONSUMED', 'EXPIRED', 'FAILED');

ALTER TABLE "plan_assignment_trainings"
ADD COLUMN "last_set_video_policy" "LastSetVideoPolicy" NOT NULL DEFAULT 'AUTO',
ADD COLUMN "requires_last_set_video" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "auto_assignment_rule_day_trainings"
ADD COLUMN "last_set_video_policy" "LastSetVideoPolicy" NOT NULL DEFAULT 'AUTO',
ADD COLUMN "requires_last_set_video" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "feedback_media"
ADD COLUMN "training_id" TEXT,
ADD COLUMN "training_exercise_id" TEXT,
ADD COLUMN "assignment_date" DATE,
ADD COLUMN "feedback_kind" "FeedbackKind" NOT NULL DEFAULT 'GENERAL';

ALTER TABLE "feedback_media"
ADD CONSTRAINT "feedback_media_training_id_fkey"
FOREIGN KEY ("training_id") REFERENCES "trainings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "feedback_media"
ADD CONSTRAINT "feedback_media_training_exercise_id_fkey"
FOREIGN KEY ("training_exercise_id") REFERENCES "training_exercises"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "feedback_media_client_id_assignment_date_training_id_training_exercise_id_idx"
ON "feedback_media"("client_id", "assignment_date", "training_id", "training_exercise_id");

CREATE TABLE "managed_uploads" (
  "id" TEXT NOT NULL,
  "owner_id" TEXT NOT NULL,
  "approval_request_id" TEXT,
  "purpose" "ManagedUploadPurpose" NOT NULL,
  "object_key" TEXT NOT NULL,
  "mime_type" TEXT NOT NULL,
  "expected_bytes" INTEGER NOT NULL,
  "actual_bytes" INTEGER,
  "status" "ManagedUploadStatus" NOT NULL DEFAULT 'PENDING',
  "expires_at" TIMESTAMP(3) NOT NULL,
  "verified_at" TIMESTAMP(3),
  "consumed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "managed_uploads_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "managed_uploads_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "managed_uploads_approval_request_id_fkey" FOREIGN KEY ("approval_request_id") REFERENCES "approval_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "managed_uploads_object_key_key" ON "managed_uploads"("object_key");
CREATE INDEX "managed_uploads_owner_id_status_expires_at_idx" ON "managed_uploads"("owner_id", "status", "expires_at");
CREATE INDEX "managed_uploads_status_expires_at_idx" ON "managed_uploads"("status", "expires_at");
CREATE INDEX "managed_uploads_approval_request_id_status_idx" ON "managed_uploads"("approval_request_id", "status");

-- Existing plans: require videos only in the natural week (Mon-Sun) that
-- contains the first assigned workout of each client and calendar month.
WITH first_training AS (
  SELECT
    pa."client_id",
    date_trunc('month', pa."date") AS month_start,
    date_trunc('week', MIN(pa."date")) AS first_week_start
  FROM "plan_assignments" pa
  WHERE EXISTS (
    SELECT 1 FROM "plan_assignment_trainings" pat
    WHERE pat."assignment_id" = pa."id"
  )
  GROUP BY pa."client_id", date_trunc('month', pa."date")
)
UPDATE "plan_assignment_trainings" pat
SET "requires_last_set_video" = true
FROM "plan_assignments" pa, first_training ft
WHERE pat."assignment_id" = pa."id"
  AND ft."client_id" = pa."client_id"
  AND ft.month_start = date_trunc('month', pa."date")
  AND ft.first_week_start = date_trunc('week', pa."date");
