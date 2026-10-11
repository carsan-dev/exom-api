-- Additive and metadata-only on PostgreSQL >= 11 (constant enum default): no
-- table rewrite, no row triggers and no day_progress writes. Every existing row
-- reads 'ALL', which is exactly the behaviour before this migration. Journal
-- row images captured earlier lack the key; readers must treat absence as ALL.
CREATE TYPE "TrainingCompletionMode" AS ENUM ('ALL', 'ANY');

ALTER TABLE "plan_assignments"
  ADD COLUMN "training_completion_mode" "TrainingCompletionMode" NOT NULL DEFAULT 'ALL';

ALTER TABLE "auto_assignment_rules"
  ADD COLUMN "training_completion_mode" "TrainingCompletionMode" NOT NULL DEFAULT 'ALL';
