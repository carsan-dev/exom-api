-- Separate migration: PostgreSQL must commit the new enum value before using it.
ALTER TABLE notifications ALTER COLUMN status SET DEFAULT 'PENDING';

-- Every writer (including bulk/replay/repair SQL) leaves durable aggregate work.
-- Tx identity coalesces multiple writes in one business transaction, never across commits.
CREATE FUNCTION exom_queue_reconcile() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_key TEXT; event_key TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - 'updated_at') = (to_jsonb(OLD) - 'updated_at') THEN RETURN NEW; END IF;
  owner_key := CASE WHEN TG_OP = 'DELETE' THEN OLD.client_id ELSE NEW.client_id END;
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = owner_key) THEN RETURN NULL; END IF;
  event_key := 'reconcile:' || owner_key || ':' || txid_current()::text;
  INSERT INTO durable_work(key,kind,payload,owner_id)
    VALUES(event_key,'RECONCILE','{}',owner_key) ON CONFLICT DO NOTHING;
  RETURN NULL;
END $$;
CREATE TRIGGER durable_progress AFTER INSERT OR UPDATE OR DELETE ON day_progress FOR EACH ROW EXECUTE FUNCTION exom_queue_reconcile();
CREATE TRIGGER durable_metrics AFTER INSERT OR UPDATE OR DELETE ON body_metrics FOR EACH ROW EXECUTE FUNCTION exom_queue_reconcile();
CREATE TRIGGER durable_streak AFTER INSERT OR UPDATE OR DELETE ON streaks FOR EACH ROW EXECUTE FUNCTION exom_queue_reconcile();
CREATE TRIGGER durable_challenge AFTER INSERT OR UPDATE OR DELETE ON challenge_clients FOR EACH ROW EXECUTE FUNCTION exom_queue_reconcile();

CREATE FUNCTION exom_queue_milestone() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event_key TEXT;
BEGIN
  IF NEW.current_days NOT IN (7,30,100,365) THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.current_days = OLD.current_days THEN RETURN NEW; END IF;
  -- Same milestone in the same streak episode/date is never emitted twice by recomputation.
  event_key := 'streak:' || NEW.client_id || ':' || COALESCE(NEW.tracking_started_at::text,'initial') || ':' || COALESCE(NEW.last_active_date::text,'unknown') || ':' || NEW.current_days;
  INSERT INTO durable_work(key,kind,payload,owner_id) VALUES(event_key,'STREAK_MILESTONE',jsonb_build_object('days',NEW.current_days),NEW.client_id) ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER durable_milestone AFTER INSERT OR UPDATE ON streaks FOR EACH ROW EXECUTE FUNCTION exom_queue_milestone();

CREATE FUNCTION exom_queue_achievement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO durable_work(key,kind,payload,owner_id)
    SELECT 'achievement:' || NEW.user_id || ':' || NEW.achievement_id,'ACHIEVEMENT',jsonb_build_object('id',a.id,'name',a.name),NEW.user_id FROM achievements a WHERE a.id=NEW.achievement_id ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER durable_achievement AFTER INSERT ON user_achievements FOR EACH ROW EXECUTE FUNCTION exom_queue_achievement();

CREATE FUNCTION exom_queue_challenge_notification() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event_kind TEXT;
BEGIN
  IF TG_OP='INSERT' THEN event_kind := 'CHALLENGE_ASSIGNED';
  ELSIF NEW.is_completed AND NOT OLD.is_completed THEN event_kind := 'CHALLENGE_COMPLETED';
  ELSE RETURN NEW;
  END IF;
  INSERT INTO durable_work(key,kind,payload,owner_id)
    SELECT event_kind || ':' || NEW.client_id || ':' || NEW.challenge_id,event_kind,jsonb_build_object('id',c.id,'name',c.title,'sender',c.created_by),NEW.client_id FROM challenges c WHERE c.id=NEW.challenge_id ON CONFLICT DO NOTHING;
  IF TG_OP='INSERT' AND NEW.is_completed THEN
    INSERT INTO durable_work(key,kind,payload,owner_id)
      SELECT 'CHALLENGE_COMPLETED:' || NEW.client_id || ':' || NEW.challenge_id,'CHALLENGE_COMPLETED',jsonb_build_object('id',c.id,'name',c.title,'sender',c.created_by),NEW.client_id FROM challenges c WHERE c.id=NEW.challenge_id ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER durable_challenge_notification AFTER INSERT OR UPDATE ON challenge_clients FOR EACH ROW EXECUTE FUNCTION exom_queue_challenge_notification();

-- FCM work is committed atomically even when a caller creates a notification directly.
CREATE FUNCTION exom_queue_fcm() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'PENDING' THEN
    INSERT INTO durable_work(key,kind,payload,owner_id) VALUES(NEW.id,'FCM','{}',NEW.recipient_id) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER durable_notification AFTER INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION exom_queue_fcm();
CREATE FUNCTION exom_remove_notification_work() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM durable_work WHERE key=OLD.id AND kind='FCM';
  RETURN OLD;
END $$;
CREATE TRIGGER durable_notification_delete BEFORE DELETE ON notifications FOR EACH ROW EXECUTE FUNCTION exom_remove_notification_work();

-- Bootstrap aggregates only: no fabricated historical notification deliveries.
INSERT INTO durable_work(key,kind,payload,owner_id)
  SELECT 'reconcile:bootstrap:' || id,'RECONCILE','{}',id FROM users WHERE role='CLIENT';
