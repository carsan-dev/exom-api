BEGIN;
ALTER TABLE "client_deletions"
  ADD COLUMN "settle_after" TIMESTAMP(3),
  ADD COLUMN "last_verified_at" TIMESTAMP(3),
  ADD COLUMN "cleanup_cursor" INTEGER NOT NULL DEFAULT 0;

UPDATE "client_deletions"
SET "settle_after" = "created_at" + CASE
  WHEN "firebase_uid" IS NOT NULL THEN interval '1 hour'
  WHEN cardinality("object_keys") > 0 THEN interval '15 minutes'
  ELSE interval '0 seconds'
END;

-- No reviewed flag or approval is required. Existing receipts become eligible
-- for the same automatic verification and periodic reconciliation as new ones.
CREATE INDEX "client_deletions_next_attempt_at_idx" ON "client_deletions"("next_attempt_at");
COMMIT;
