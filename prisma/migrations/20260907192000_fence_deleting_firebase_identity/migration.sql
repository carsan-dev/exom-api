CREATE OR REPLACE FUNCTION "guard_deleted_client_references"() RETURNS trigger LANGUAGE plpgsql AS $$
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
    -- A UNIQUE Firebase UID insert may wait until the old User disappears.
    -- Fence before checking the journal, including non-UUID Firebase UIDs.
    PERFORM 1 FROM users WHERE firebase_uid = NEW.firebase_uid FOR KEY SHARE;
    IF EXISTS (SELECT 1 FROM client_deletions WHERE firebase_uid = NEW.firebase_uid) THEN
      RAISE EXCEPTION 'CLIENT_DELETED' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

