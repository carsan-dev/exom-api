ALTER TABLE "training_exercises"
ADD COLUMN "request_set_tracking" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "feedback_media"
ADD COLUMN "client_upload_id" TEXT;

CREATE UNIQUE INDEX "feedback_media_client_id_client_upload_id_key"
ON "feedback_media"("client_id", "client_upload_id");
