-- Preserve existing orphaned historical rows if any, while enforcing the
-- relationship for every new write. Constraints can be validated separately
-- after an explicit orphan audit.
ALTER TABLE "plan_assignments"
  ADD CONSTRAINT "plan_assignments_client_id_fkey"
  FOREIGN KEY ("client_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;

ALTER TABLE "plan_assignments"
  ADD CONSTRAINT "plan_assignments_admin_id_fkey"
  FOREIGN KEY ("admin_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;

ALTER TABLE "auto_assignment_rules"
  ADD CONSTRAINT "auto_assignment_rules_client_id_fkey"
  FOREIGN KEY ("client_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;

ALTER TABLE "auto_assignment_rules"
  ADD CONSTRAINT "auto_assignment_rules_admin_id_fkey"
  FOREIGN KEY ("admin_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;

CREATE INDEX "plan_assignments_admin_id_idx"
  ON "plan_assignments"("admin_id");

CREATE INDEX "auto_assignment_rules_admin_id_idx"
  ON "auto_assignment_rules"("admin_id");
