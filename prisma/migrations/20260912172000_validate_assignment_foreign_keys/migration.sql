-- Run the read-only audit before scheduling this migration.
-- No DELETE, reattribution, or mutation of historical IDs is allowed here.
-- Orphans fail validation and roll back all four catalog changes.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
ALTER TABLE "plan_assignments" VALIDATE CONSTRAINT "plan_assignments_client_id_fkey";
ALTER TABLE "plan_assignments" VALIDATE CONSTRAINT "plan_assignments_admin_id_fkey";
ALTER TABLE "auto_assignment_rules" VALIDATE CONSTRAINT "auto_assignment_rules_client_id_fkey";
ALTER TABLE "auto_assignment_rules" VALIDATE CONSTRAINT "auto_assignment_rules_admin_id_fkey";
COMMIT;
