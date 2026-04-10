UPDATE "users"
SET
  "tier" = 'HIGH_TICKET',
  "trial_expires_at" = NULL
WHERE "role" = 'CLIENT';

ALTER TABLE "users"
DROP COLUMN "trial_expires_at",
DROP COLUMN "tier";

DROP TYPE "ClientTier";
