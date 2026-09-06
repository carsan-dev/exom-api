BEGIN;
ALTER TABLE "day_progress" ADD COLUMN "sync_revision" INTEGER NOT NULL DEFAULT 0;
UPDATE "day_progress" SET "sync_revision" = 1;
CREATE TABLE "progress_operations" (
 "owner_id" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
 "id" TEXT NOT NULL, "date" DATE NOT NULL, "payload_hash" TEXT NOT NULL,
 "response" JSONB NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY("owner_id", "id")
);
-- Every writer (including older API instances and reconciliation) advances the
-- revision for a semantic progress change. No application-maintained dual write.
CREATE FUNCTION exom_progress_revision() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'INSERT' THEN NEW.sync_revision := 1;
 ELSIF ROW(NEW.training_completed, NEW.trainings_completed, NEW.exercises_completed,
   NEW.meals_completed, NEW.notes) IS DISTINCT FROM ROW(OLD.training_completed,
   OLD.trainings_completed, OLD.exercises_completed, OLD.meals_completed, OLD.notes) THEN
   NEW.sync_revision := OLD.sync_revision + 1;
 ELSE NEW.sync_revision := OLD.sync_revision;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER day_progress_revision BEFORE INSERT OR UPDATE ON "day_progress"
 FOR EACH ROW EXECUTE FUNCTION exom_progress_revision();

ALTER TABLE "progress_operations" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "progress_operations" FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN REVOKE ALL ON TABLE "progress_operations" FROM anon; END IF;
 IF EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN REVOKE ALL ON TABLE "progress_operations" FROM authenticated; END IF;
END $$;

COMMIT;
