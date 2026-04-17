-- AlterTable
ALTER TABLE "feedback_media" ADD COLUMN     "media_deleted_at" TIMESTAMP(3),
ALTER COLUMN "media_url" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "feedback_media_status_reviewed_at_media_deleted_at_idx" ON "feedback_media"("status", "reviewed_at", "media_deleted_at");
