BEGIN;

ALTER TABLE users ADD COLUMN identity_pending BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN sessions_revoked_at TIMESTAMP(3);

CREATE TABLE identity_operations (
  id TEXT PRIMARY KEY,
  request_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  user_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  firebase_uid TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('CREATE', 'SYNC', 'REVOKE')),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'COMPLETED', 'COMPENSATED', 'BLOCKED', 'CANCELLED')),
  firebase_owned BOOLEAN NOT NULL DEFAULT false,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP(3)
);
CREATE INDEX identity_operations_due ON identity_operations(status, next_attempt_at);
CREATE INDEX identity_operations_user ON identity_operations(user_id);
CREATE UNIQUE INDEX identity_operations_one_pending ON identity_operations(user_id)
  WHERE status IN ('PENDING', 'BLOCKED');

-- A login/link cannot move an identity while recovery owns its state.
CREATE FUNCTION guard_pending_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.identity_pending AND NEW.firebase_uid IS DISTINCT FROM OLD.firebase_uid THEN
    RAISE EXCEPTION 'IDENTITY_RECOVERY_PENDING' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER users_pending_identity BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION guard_pending_identity();

CREATE FUNCTION guard_reserved_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- A compensated creation UID must never be rebound by an old social token.
  IF EXISTS (SELECT 1 FROM identity_operations WHERE firebase_uid = NEW.firebase_uid
    AND kind = 'CREATE' AND (user_id <> NEW.id OR status IN ('COMPENSATED', 'BLOCKED', 'CANCELLED'))) THEN
    RAISE EXCEPTION 'IDENTITY_OWNERSHIP_REVIEW' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER users_reserved_identity BEFORE INSERT OR UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION guard_reserved_identity();

COMMIT;
