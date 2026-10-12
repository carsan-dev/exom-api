CREATE TYPE "ClientFollowUpTaskType" AS ENUM ('TRAINING_UPDATE', 'DIET_UPDATE', 'PHOTO_REVIEW', 'RECAP_REVIEW', 'REVIEW', 'CALL', 'FEEDBACK');
CREATE TYPE "ClientFollowUpTaskPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH');
CREATE TYPE "ClientFollowUpTaskStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

CREATE TABLE "client_followup_tasks" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "assigned_to_id" TEXT,
    "created_by_id" TEXT,
    "type" "ClientFollowUpTaskType" NOT NULL,
    "title" VARCHAR(160) NOT NULL,
    "description" VARCHAR(3000),
    "due_date" DATE NOT NULL,
    "priority" "ClientFollowUpTaskPriority" NOT NULL DEFAULT 'MEDIUM',
    "status" "ClientFollowUpTaskStatus" NOT NULL DEFAULT 'PENDING',
    "version" INTEGER NOT NULL DEFAULT 1,
    "completed_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "client_followup_tasks_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "client_followup_tasks_title_check" CHECK (length(btrim("title")) > 0),
    CONSTRAINT "client_followup_tasks_version_check" CHECK ("version" >= 1),
    CONSTRAINT "client_followup_tasks_lifecycle_check" CHECK (
        ("status" IN ('PENDING', 'IN_PROGRESS') AND "completed_at" IS NULL AND "cancelled_at" IS NULL)
        OR ("status" = 'COMPLETED' AND "completed_at" IS NOT NULL AND "cancelled_at" IS NULL)
        OR ("status" = 'CANCELLED' AND "completed_at" IS NULL AND "cancelled_at" IS NOT NULL)
    ),
    CONSTRAINT "client_followup_tasks_client_id_fkey"
        FOREIGN KEY ("client_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "client_followup_tasks_assigned_to_id_fkey"
        FOREIGN KEY ("assigned_to_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "client_followup_tasks_created_by_id_fkey"
        FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "client_followup_tasks_queue_idx" ON "client_followup_tasks"("client_id", "status", "due_date", "priority", "created_at");
CREATE INDEX "client_followup_tasks_type_queue_idx" ON "client_followup_tasks"("client_id", "type", "status", "due_date");
