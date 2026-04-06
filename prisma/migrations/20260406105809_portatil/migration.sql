-- CreateEnum
CREATE TYPE "ClientTier" AS ENUM ('HIGH_TICKET', 'LOW_TICKET');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "tier" "ClientTier" NOT NULL DEFAULT 'LOW_TICKET',
ADD COLUMN     "trial_expires_at" TIMESTAMP(3);
