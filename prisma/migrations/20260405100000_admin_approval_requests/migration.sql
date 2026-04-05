CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'FAILED');

ALTER TABLE "exercises"
ADD COLUMN "created_by" TEXT;

ALTER TABLE "ingredients"
ADD COLUMN "created_by" TEXT;

ALTER TABLE "achievements"
ADD COLUMN "created_by" TEXT;

CREATE TABLE "approval_requests" (
  "id" TEXT NOT NULL,
  "requester_id" TEXT NOT NULL,
  "reviewer_id" TEXT,
  "action_type" TEXT NOT NULL,
  "resource_type" TEXT NOT NULL,
  "resource_id" TEXT,
  "payload" JSONB NOT NULL,
  "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
  "rejection_reason" TEXT,
  "failure_reason" TEXT,
  "resolved_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "approval_requests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "unique_pending_request"
ON "approval_requests"("requester_id", "action_type", "resource_id", "status");

CREATE INDEX "approval_requests_requester_id_status_created_at_idx"
ON "approval_requests"("requester_id", "status", "created_at");

CREATE INDEX "approval_requests_status_created_at_idx"
ON "approval_requests"("status", "created_at");

CREATE INDEX "approval_requests_resource_type_resource_id_status_idx"
ON "approval_requests"("resource_type", "resource_id", "status");

CREATE UNIQUE INDEX "approval_requests_unique_pending"
ON "approval_requests"("requester_id", "action_type", "resource_id")
WHERE "status" = 'PENDING';

ALTER TABLE "approval_requests"
ADD CONSTRAINT "approval_requests_requester_id_fkey"
FOREIGN KEY ("requester_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "approval_requests"
ADD CONSTRAINT "approval_requests_reviewer_id_fkey"
FOREIGN KEY ("reviewer_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
