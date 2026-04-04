-- CreateIndex
CREATE INDEX "admin_client_assignments_client_id_is_active_created_at_id_idx" ON "admin_client_assignments"("client_id", "is_active", "created_at", "id");
