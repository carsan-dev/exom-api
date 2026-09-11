-- A business confirmation can race the last failing notification attempt.
-- Rearm every unfinished resolution, including RUNNING. Its advisory lock still
-- excludes another live consumer; clearing the token fences the stale finish.
CREATE OR REPLACE FUNCTION exom_queue_approval_notification() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event_kind TEXT; event_key TEXT;
BEGIN
  IF TG_OP='INSERT' THEN event_kind := 'APPROVAL_PENDING';
  ELSIF NEW.status IS DISTINCT FROM OLD.status OR NEW.execution_completed_at IS DISTINCT FROM OLD.execution_completed_at THEN event_kind := 'APPROVAL_RESOLUTION';
  ELSE RETURN NEW;
  END IF;
  event_key := event_kind || ':' || NEW.id;
  INSERT INTO durable_work(key,kind,payload,owner_id)
    VALUES(event_key,event_kind,jsonb_build_object('id',NEW.id),NEW.requester_id)
    ON CONFLICT(key) DO UPDATE SET status='PENDING',attempts=0,last_error=NULL,
      next_attempt_at=timezone('UTC',clock_timestamp()),claim_token=NULL,lease_until=NULL,completed_at=NULL
    WHERE durable_work.status IN ('PENDING','RUNNING','FAILED');
  RETURN NEW;
END $$;

-- Recover confirmations already stranded by the old race, preserving DONE and
-- the existing event identity. An ambiguous business action is never replayed.
UPDATE durable_work w SET status='PENDING',attempts=0,last_error=NULL,
  next_attempt_at=timezone('UTC',clock_timestamp()),claim_token=NULL,lease_until=NULL,completed_at=NULL
FROM approval_requests a
WHERE w.kind='APPROVAL_RESOLUTION' AND w.payload->>'id'=a.id
  AND w.status IN ('PENDING','RUNNING','FAILED')
  AND a.status='APPROVED' AND a.execution_completed_at IS NOT NULL;
