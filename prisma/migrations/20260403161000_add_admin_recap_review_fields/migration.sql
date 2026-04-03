-- AlterTable
ALTER TABLE "weekly_recaps"
ADD COLUMN     "admin_comments" TEXT,
ADD COLUMN     "archived_at" TIMESTAMP(3),
ADD COLUMN     "reviewed_at" TIMESTAMP(3),
ADD COLUMN     "submitted_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "weekly_recaps_client_id_status_archived_at_week_start_date_idx" ON "weekly_recaps"("client_id", "status", "archived_at", "week_start_date");
