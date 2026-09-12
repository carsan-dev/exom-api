-- Measured against Admin lists and exercise usage; see docs/data-access.md.
-- Transactional, bounded wait: a busy database aborts without partial indexes.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
CREATE INDEX "users_role_created_at_id_idx" ON "users"("role", "created_at", "id");
CREATE INDEX "notifications_recipient_id_created_at_id_idx" ON "notifications"("recipient_id", "created_at", "id");
CREATE INDEX "feedback_media_client_id_created_at_id_idx" ON "feedback_media"("client_id", "created_at", "id");
CREATE INDEX "training_exercises_exercise_id_training_id_idx" ON "training_exercises"("exercise_id", "training_id");
COMMIT;
