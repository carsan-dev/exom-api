BEGIN;
-- Replace only the live-occurrence FK. Keep the public scalar identity and all
-- owner/media/training/exercise constraints; do not invent previously nulled IDs.
ALTER TABLE feedback_media DROP CONSTRAINT feedback_media_training_exercise_id_fkey;

CREATE FUNCTION exom_feedback_occurrence_before() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE history JSONB;
BEGIN
  IF NEW.training_exercise_id IS NULL THEN RETURN NEW; END IF;
  PERFORM exom_rir_lock_client(NEW.client_id);
  IF NEW.feedback_kind='LAST_SET' THEN
    IF NEW.assignment_date IS NULL OR NOT EXISTS (
      SELECT 1 FROM plan_assignments a JOIN plan_assignment_trainings l ON l.assignment_id=a.id
      WHERE a.client_id=NEW.client_id AND a.date=NEW.assignment_date AND l.training_id=NEW.training_id
    ) THEN RAISE EXCEPTION 'Feedback occurrence is not assigned' USING ERRCODE='23503'; END IF;
    -- Submitting the last-set video is persisted activity. Capture the temporal
    -- prescription before accepting it, including writes outside FeedbackService.
    PERFORM exom_capture_timed_day(NEW.client_id,NEW.assignment_date);
  END IF;
  SELECT payload INTO history FROM training_day_snapshots
    WHERE client_id=NEW.client_id AND date=NEW.assignment_date AND training_id=NEW.training_id;
  IF history IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(history->'exercises') e
      WHERE e->>'id'=NEW.training_exercise_id AND e->>'exercise_id'=NEW.exercise_id)
      THEN
        IF NEW.feedback_kind='LAST_SET' THEN
          INSERT INTO rir_protected_days(client_id,date) VALUES(NEW.client_id,NEW.assignment_date) ON CONFLICT DO NOTHING;
        END IF;
        RETURN NEW;
      END IF;
  ELSIF EXISTS (SELECT 1 FROM training_exercises e WHERE e.id=NEW.training_exercise_id
    AND (NEW.training_id IS NULL OR e.training_id=NEW.training_id)
    AND (NEW.exercise_id IS NULL OR e.exercise_id=NEW.exercise_id)) THEN RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Feedback occurrence is not in catalogue or owned history' USING ERRCODE='23503';
END $$;
CREATE TRIGGER feedback_occurrence_before
  BEFORE INSERT OR UPDATE OF training_exercise_id,client_id,assignment_date,training_id,exercise_id ON feedback_media
  FOR EACH ROW EXECUTE FUNCTION exom_feedback_occurrence_before();

-- Preserve SET NULL behavior for unrelated nonhistorical feedback, but retain
-- the original occurrence when this owner's dated snapshot still contains it.
CREATE FUNCTION exom_feedback_occurrence_deleted() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  UPDATE feedback_media f SET training_exercise_id=NULL
  WHERE f.training_exercise_id=OLD.id AND NOT EXISTS (
    SELECT 1 FROM training_day_snapshots s
    WHERE s.client_id=f.client_id AND s.date=f.assignment_date AND s.training_id=f.training_id
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(s.payload->'exercises') e
        WHERE e->>'id'=OLD.id AND e->>'exercise_id'=f.exercise_id)
  );
  RETURN OLD;
END $$;
CREATE TRIGGER feedback_occurrence_deleted AFTER DELETE ON training_exercises
  FOR EACH ROW EXECUTE FUNCTION exom_feedback_occurrence_deleted();
COMMIT;
