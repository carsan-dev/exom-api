BEGIN;

-- Each table has a different row shape. Resolve target-only fields only after
-- selecting the UPDATE branch for rir_day_targets, not inside a shared AND.
CREATE OR REPLACE FUNCTION exom_rir_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Preserve the existing exception for the explicit deletion of the owner.
    IF NOT EXISTS (SELECT 1 FROM users WHERE id = OLD.client_id) THEN
      RETURN OLD;
    END IF;
  ELSIF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'rir_day_targets' THEN
    IF NOT exom_rir_protected(OLD.client_id, OLD.date) THEN
      IF (OLD.client_id, OLD.date, OLD.training_exercise_id, OLD.training_id) =
         (NEW.client_id, NEW.date, NEW.training_exercise_id, NEW.training_id) THEN
        RETURN NEW;
      END IF;
    END IF;
  END IF;

  RAISE EXCEPTION 'RIR history is protected' USING ERRCODE = '23514';
END $$;

COMMIT;
