-- CreateIndex
CREATE INDEX "admin_client_assignments_admin_id_is_active_created_at_id_idx" ON "admin_client_assignments"("admin_id", "is_active", "created_at", "id");

-- CreateIndex
CREATE INDEX "admin_client_assignments_admin_id_client_id_is_active_idx" ON "admin_client_assignments"("admin_id", "client_id", "is_active");
