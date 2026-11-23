-- Persistent onboarding state (plan onboarding-persistente, OP-D1).
-- Additive only: one enum and two nullable columns without default. No data is
-- written here; existing clients are marked by the separate, explicitly
-- authorized backfill (scripts/onboarding-state-backfill.cjs).
-- Withdrawal SQL: scripts/sql/onboarding-state/rollback.sql.

-- CreateEnum
CREATE TYPE "OnboardingOutcome" AS ENUM ('COMPLETED', 'SKIPPED');

-- AlterTable
ALTER TABLE "profiles" ADD COLUMN "onboarding_completed_at" TIMESTAMP(3),
ADD COLUMN "onboarding_outcome" "OnboardingOutcome";
