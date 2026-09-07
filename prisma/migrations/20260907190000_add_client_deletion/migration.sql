CREATE TABLE "client_deletions" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "client_id" TEXT NOT NULL UNIQUE,
  "requested_by" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "firebase_uid" TEXT,
  "object_keys" TEXT[] NOT NULL,
  "storage_review" BOOLEAN NOT NULL DEFAULT false,
  "claimed_at" TIMESTAMP(3),
  "claim_token" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMP(3),
  CONSTRAINT "client_deletions_status_check" CHECK ("status" IN ('PENDING', 'PROCESSING', 'BLOCKED', 'COMPLETED'))
);
CREATE INDEX "client_deletions_status_next_attempt_at_idx" ON "client_deletions"("status", "next_attempt_at");

-- Untyped references must not resurrect a deleted client's data. Lock living
-- owners before checking the tombstone so a concurrent deletion is observed.
-- No legacy rows are rewritten or assigned an inferred owner.
CREATE FUNCTION "guard_deleted_client_references"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE reference_id TEXT;
BEGIN
  FOR reference_id IN
    SELECT DISTINCT value #>> '{}' FROM jsonb_path_query(to_jsonb(NEW), '$.** ? (@.type() == "string")') AS v(value)
    ORDER BY 1
  LOOP
    PERFORM 1 FROM users WHERE id = reference_id FOR KEY SHARE;
    IF EXISTS (SELECT 1 FROM client_deletions WHERE client_id = reference_id) THEN
      RAISE EXCEPTION 'CLIENT_DELETED' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  IF TG_TABLE_NAME = 'users' THEN
    IF EXISTS (SELECT 1 FROM client_deletions WHERE firebase_uid = NEW.firebase_uid) THEN
      RAISE EXCEPTION 'CLIENT_DELETED' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- Includes JSON payloads and non-FK authorship/reviewer fields.
DO $$ DECLARE table_name TEXT; BEGIN
  FOREACH table_name IN ARRAY ARRAY['users', 'notifications', 'approval_requests', 'trainings', 'exercises', 'diets', 'ingredients', 'challenges', 'achievements', 'feedback_media', 'profiles', 'managed_uploads'] LOOP
    EXECUTE format('CREATE TRIGGER guard_deleted_client_references BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION guard_deleted_client_references()', table_name);
  END LOOP;
END $$;
