-- AlterTable
ALTER TABLE "challenges"
ADD COLUMN     "rule_key" TEXT,
ADD COLUMN     "rule_config" JSONB;
