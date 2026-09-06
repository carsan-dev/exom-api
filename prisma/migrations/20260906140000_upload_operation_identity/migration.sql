BEGIN;
ALTER TABLE "managed_uploads" ADD COLUMN "client_operation_id" TEXT;
CREATE UNIQUE INDEX "managed_uploads_owner_id_client_operation_id_key" ON "managed_uploads"("owner_id", "client_operation_id");
ALTER TABLE "managed_uploads" ADD COLUMN "object_deleted_at" TIMESTAMP(3);

COMMIT;
