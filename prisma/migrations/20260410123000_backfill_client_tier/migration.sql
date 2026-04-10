UPDATE "users"
SET "tier" = 'HIGH_TICKET'
WHERE "role" = 'CLIENT'
  AND "trial_expires_at" IS NULL;
