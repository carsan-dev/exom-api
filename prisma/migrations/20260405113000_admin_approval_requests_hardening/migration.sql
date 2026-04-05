ALTER TABLE "approval_requests"
ADD COLUMN "request_reason" TEXT;

DROP INDEX IF EXISTS "unique_pending_request";
