-- Withdrawal of 20261123120000_profile_onboarding_state (plan OP-MIG-08).
-- WARNING: destroys every onboarding mark (dates and outcomes). Only valid
-- before an App version that reads the server state is published; afterwards
-- clients without a local mark would see the onboarding again.
-- Requires explicit authorization covering action, environment and population.
-- Removing the _prisma_migrations record lets `prisma migrate deploy`
-- re-apply the migration later. Runs as a single transaction.
BEGIN;
ALTER TABLE "profiles" DROP COLUMN "onboarding_outcome",
DROP COLUMN "onboarding_completed_at";
DROP TYPE "OnboardingOutcome";
DELETE FROM "_prisma_migrations"
 WHERE "migration_name" = '20261123120000_profile_onboarding_state';
COMMIT;
