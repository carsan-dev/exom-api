DROP INDEX IF EXISTS "approval_requests_unique_pending";

CREATE UNIQUE INDEX "approval_requests_unique_pending"
ON "approval_requests"(
  "requester_id",
  "action_type",
  (COALESCE("resource_id", '__NO_RESOURCE__'))
)
WHERE "status" = 'PENDING';
