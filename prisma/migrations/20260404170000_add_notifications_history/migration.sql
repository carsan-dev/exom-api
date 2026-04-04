CREATE TYPE "NotificationStatus" AS ENUM ('SENT', 'FAILED');

CREATE TABLE "notifications" (
  "id" TEXT NOT NULL,
  "sender_id" TEXT NOT NULL,
  "recipient_id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "data" JSONB,
  "status" "NotificationStatus" NOT NULL DEFAULT 'SENT',
  "error" TEXT,
  "read_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "notifications_sender_id_created_at_idx" ON "notifications"("sender_id", "created_at");
CREATE INDEX "notifications_recipient_id_read_at_created_at_idx" ON "notifications"("recipient_id", "read_at", "created_at");

ALTER TABLE "notifications"
ADD CONSTRAINT "notifications_sender_id_fkey"
FOREIGN KEY ("sender_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "notifications"
ADD CONSTRAINT "notifications_recipient_id_fkey"
FOREIGN KEY ("recipient_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
