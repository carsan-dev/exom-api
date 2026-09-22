BEGIN;

ALTER TYPE "ManagedUploadPurpose" ADD VALUE IF NOT EXISTS 'PROGRESS_PHOTO';
CREATE TYPE "ProgressPhotoView" AS ENUM ('FRONT', 'LEFT', 'RIGHT', 'BACK');
CREATE TYPE "ProgressPhotoState" AS ENUM ('ACTIVE', 'REPLACED');

CREATE TABLE "progress_photo_sessions" (
  "id" TEXT NOT NULL,
  "client_id" TEXT NOT NULL,
  "uploader_id" TEXT NOT NULL,
  "session_date" DATE NOT NULL,
  "session_operation_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "progress_photo_sessions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "progress_photo_sessions_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "progress_photo_sessions_uploader_id_fkey"
    FOREIGN KEY ("uploader_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "progress_photos" (
  "id" TEXT NOT NULL,
  "session_id" TEXT NOT NULL,
  "client_id" TEXT NOT NULL,
  "uploader_id" TEXT NOT NULL,
  "managed_upload_id" TEXT NOT NULL,
  "view" "ProgressPhotoView" NOT NULL,
  "state" "ProgressPhotoState" NOT NULL DEFAULT 'ACTIVE',
  "association_operation_id" TEXT NOT NULL,
  "replaces_photo_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "progress_photos_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "progress_photos_session_id_client_id_fkey"
    FOREIGN KEY ("session_id", "client_id") REFERENCES "progress_photo_sessions"("id", "client_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "progress_photos_uploader_id_fkey"
    FOREIGN KEY ("uploader_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "progress_photos_managed_upload_id_fkey"
    FOREIGN KEY ("managed_upload_id") REFERENCES "managed_uploads"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "progress_photos_replaces_photo_id_fkey"
    FOREIGN KEY ("replaces_photo_id") REFERENCES "progress_photos"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "progress_photo_sessions_id_client_id_key"
  ON "progress_photo_sessions"("id", "client_id");
CREATE UNIQUE INDEX "progress_photo_sessions_uploader_id_session_operation_id_key"
  ON "progress_photo_sessions"("uploader_id", "session_operation_id");
CREATE INDEX "progress_photo_sessions_client_id_session_date_id_idx"
  ON "progress_photo_sessions"("client_id", "session_date", "id");

CREATE UNIQUE INDEX "progress_photos_managed_upload_id_key"
  ON "progress_photos"("managed_upload_id");
CREATE UNIQUE INDEX "progress_photos_replaces_photo_id_key"
  ON "progress_photos"("replaces_photo_id");
CREATE UNIQUE INDEX "progress_photos_uploader_id_association_operation_id_key"
  ON "progress_photos"("uploader_id", "association_operation_id");
CREATE INDEX "progress_photos_session_id_view_state_created_at_idx"
  ON "progress_photos"("session_id", "view", "state", "created_at");
CREATE UNIQUE INDEX "progress_photos_active_session_view_key"
  ON "progress_photos"("session_id", "view") WHERE "state" = 'ACTIVE';

ALTER TABLE "client_deletions"
  ADD COLUMN "progress_photo_object_keys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

COMMIT;
