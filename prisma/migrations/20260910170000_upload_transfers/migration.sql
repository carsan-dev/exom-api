-- Durable receipts, deliberately independent of User cascades.
BEGIN;
LOCK TABLE users, managed_uploads, client_deletions IN SHARE ROW EXCLUSIVE MODE;
CREATE TABLE "upload_transfers" (
  "id" TEXT PRIMARY KEY,
  "owner_id" TEXT NOT NULL,
  "object_key" TEXT,
  "generation" TEXT NOT NULL,
  "protocol" TEXT NOT NULL CHECK ("protocol" IN ('DIRECT', 'LOCAL', 'MULTIPART')),
  "state" TEXT NOT NULL DEFAULT 'NEW' CHECK ("state" IN ('NEW', 'CREATING', 'UPLOADING', 'COMPLETING', 'PUBLISHED', 'CANCELLED', 'UNCERTAIN')),
  "multipart_id" TEXT,
  "recovery_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "external_pending" TEXT,
  "cancel_requested" BOOLEAN NOT NULL DEFAULT false,
  "etag" TEXT,
  "updated_at" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "upload_transfers_object_key_key" ON "upload_transfers"("object_key");
CREATE INDEX "upload_transfers_owner_id_state_idx" ON "upload_transfers"("owner_id", "state");
INSERT INTO "upload_transfers" (id, owner_id, object_key, generation, protocol, state, updated_at)
SELECT id, owner_id, object_key, id, 'DIRECT', 'UNCERTAIN', CURRENT_TIMESTAMP
FROM managed_uploads;
-- Old writers did not retain all issued capabilities. Absence of a session row
-- cannot certify absence of an admitted PUT. Preserve that uncertainty per owner,
-- including users already removed before this migration. No expiry backfill.
INSERT INTO "upload_transfers" (id, owner_id, generation, protocol, state, updated_at)
SELECT 'legacy-owner:' || id, id, id, 'DIRECT', 'UNCERTAIN', CURRENT_TIMESTAMP
FROM (SELECT id FROM users UNION SELECT client_id AS id FROM client_deletions) owners;

-- Mixed-version rollout: an old server's INSERT must never escape the inventory.
-- New servers insert their canonical receipt first, in the same transaction.
CREATE FUNCTION capture_legacy_upload_transfer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO upload_transfers(id, owner_id, object_key, generation, protocol, state, updated_at)
    VALUES(NEW.id, NEW.owner_id, NEW.object_key, NEW.id, 'DIRECT', 'UNCERTAIN', CURRENT_TIMESTAMP)
    ON CONFLICT (id) DO NOTHING;
  IF NOT EXISTS (SELECT 1 FROM upload_transfers WHERE id=NEW.id AND owner_id=NEW.owner_id AND object_key=NEW.object_key) THEN
    RAISE EXCEPTION 'UPLOAD_TRANSFER_IDENTITY_MISMATCH';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER managed_upload_transfer_receipt AFTER INSERT ON managed_uploads
  FOR EACH ROW EXECUTE FUNCTION capture_legacy_upload_transfer();

-- An old worker must not certify completion during a rolling deployment.
CREATE FUNCTION enforce_deletion_transfer_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status='COMPLETED' AND EXISTS (
    SELECT 1 FROM upload_transfers WHERE owner_id=NEW.client_id
      AND (protocol='DIRECT' OR state<>'CANCELLED' OR external_pending IS NOT NULL)
  ) THEN
    NEW.status := 'PENDING';
    NEW.completed_at := NULL;
    NEW.last_error := 'STORAGE_TRANSFER_PENDING';
    NEW.claimed_at := NULL;
    NEW.claim_token := NULL;
    NEW.next_attempt_at := (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') + INTERVAL '1 hour';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER client_deletion_transfer_barrier BEFORE INSERT OR UPDATE OF status ON client_deletions
  FOR EACH ROW EXECUTE FUNCTION enforce_deletion_transfer_barrier();
-- Re-evaluate earlier receipts without waiting for their next audit. Retain all
-- recovery identity/inventory; completion was not backed by a transport barrier.
UPDATE client_deletions SET status='COMPLETED' WHERE status='COMPLETED';
COMMIT;
