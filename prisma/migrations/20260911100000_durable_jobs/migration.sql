ALTER TYPE "NotificationStatus" ADD VALUE 'PENDING';
ALTER TABLE notifications ADD COLUMN provider_message_id TEXT, ADD COLUMN sent_at TIMESTAMP(3);
CREATE TABLE durable_work (
  key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload JSONB NOT NULL,
  owner_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','RUNNING','DONE','FAILED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  claim_token TEXT,
  lease_until TIMESTAMP(3),
  next_attempt_at TIMESTAMP(3) NOT NULL DEFAULT timezone('UTC', CURRENT_TIMESTAMP),
  last_error TEXT,
  created_at TIMESTAMP(3) NOT NULL DEFAULT timezone('UTC', CURRENT_TIMESTAMP),
  completed_at TIMESTAMP(3)
);
CREATE INDEX durable_work_status_next_attempt_at_idx ON durable_work(status,next_attempt_at);
CREATE INDEX durable_work_owner_id_idx ON durable_work(owner_id);
-- Same API-only access model as existing public tables; no client policies.
ALTER TABLE durable_work ENABLE ROW LEVEL SECURITY;
