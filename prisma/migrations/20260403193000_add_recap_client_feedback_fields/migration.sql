-- AlterTable
ALTER TABLE "weekly_recaps"
ADD COLUMN     "client_feedback_text" TEXT,
ADD COLUMN     "client_feedback_sent_at" TIMESTAMP(3),
ADD COLUMN     "client_feedback_read_at" TIMESTAMP(3);
