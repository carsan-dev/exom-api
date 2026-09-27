-- Do not infer historical session ratings or attach ambiguous daily notes.
ALTER TABLE "day_progress" ADD COLUMN "training_sessions" JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE "feedback_media" ADD COLUMN "training_session_id" TEXT;

-- Session-only edits must participate in the same optimistic revision as sets
-- and completions; keep this enforced for all writers, including older clients.
CREATE OR REPLACE FUNCTION exom_progress_revision() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'INSERT' THEN NEW.sync_revision := 1;
 ELSIF ROW(NEW.training_completed, NEW.trainings_completed, NEW.exercises_completed,
   NEW.meals_completed, NEW.notes, NEW.training_sessions) IS DISTINCT FROM ROW(OLD.training_completed,
   OLD.trainings_completed, OLD.exercises_completed, OLD.meals_completed, OLD.notes, OLD.training_sessions) THEN
   NEW.sync_revision := OLD.sync_revision + 1;
 ELSE NEW.sync_revision := OLD.sync_revision;
 END IF;
 RETURN NEW;
END $$;
