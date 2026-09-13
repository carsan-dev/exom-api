-- FEAT-007 recovery preparation. Execute only on an explicitly authorized destination.
-- Before rollback export training_exercises timed_config and training_day_snapshots.
-- Keep the table and column so rolling back code never destroys new prescriptions.
-- Older API versions do not understand interval edits: make the training catalog read-only
-- until the compatible API is restored. Current API already preserves omitted fields.
-- A transaction failure during the forward migration rolls back the entire migration.
-- Migration74 also preserves feedback_media.training_exercise_id for owned history.
-- Keep its integrity triggers on code rollback; do not re-add the old live FK or
-- null historical IDs to make a downgrade pass. Pause historical LAST_SET writes
-- if the old API is temporarily restored. Forward-failure rollback restores the FK
-- transactionally; this is tested with fixtures before retrying the migration.
BEGIN;
-- Read-only recovery inventory. This file deliberately contains no destructive downgrade.
SELECT count(*) AS configured_exercises FROM training_exercises WHERE timed_config IS NOT NULL;
SELECT source,count(*) AS captured_trainings FROM training_day_snapshots GROUP BY source;
SELECT count(*) AS historical_feedback_occurrences FROM feedback_media f
WHERE f.training_exercise_id IS NOT NULL
  AND NOT EXISTS(SELECT 1 FROM training_exercises e WHERE e.id=f.training_exercise_id);
ROLLBACK;
