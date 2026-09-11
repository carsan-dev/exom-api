ALTER TABLE approval_requests ADD COLUMN execution_completed_at TIMESTAMP(3);
ALTER TABLE notifications ADD COLUMN requires_client_role BOOLEAN NOT NULL DEFAULT false;

CREATE FUNCTION exom_queue_approval_notification() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event_kind TEXT; event_key TEXT;
BEGIN
  IF TG_OP='INSERT' THEN event_kind := 'APPROVAL_PENDING';
  ELSIF NEW.status IS DISTINCT FROM OLD.status OR NEW.execution_completed_at IS DISTINCT FROM OLD.execution_completed_at THEN event_kind := 'APPROVAL_RESOLUTION';
  ELSE RETURN NEW;
  END IF;
  event_key := event_kind || ':' || NEW.id;
  INSERT INTO durable_work(key,kind,payload,owner_id)
    VALUES(event_key,event_kind,jsonb_build_object('id',NEW.id),NEW.requester_id)
    ON CONFLICT(key) DO UPDATE SET status='PENDING',attempts=0,last_error=NULL,next_attempt_at=timezone('UTC',clock_timestamp())
    WHERE durable_work.status='FAILED';
  RETURN NEW;
END $$;
CREATE TRIGGER durable_approval AFTER INSERT OR UPDATE ON approval_requests FOR EACH ROW EXECUTE FUNCTION exom_queue_approval_notification();
