-- Catalog edits also have post-commit recomputers. Retain their intent if the
-- API crashes after changing the rule. Do not grant historical notifications.
CREATE FUNCTION exom_queue_achievement_catalog() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.criteria_type IS NOT DISTINCT FROM OLD.criteria_type
    AND NEW.criteria_value IS NOT DISTINCT FROM OLD.criteria_value
    AND NEW.rule_config IS NOT DISTINCT FROM OLD.rule_config THEN RETURN NEW; END IF;
  IF NEW.criteria_type='CUSTOM' THEN
    DELETE FROM user_achievements WHERE achievement_id=NEW.id AND unlock_source='AUTOMATIC';
    RETURN NEW;
  END IF;
  INSERT INTO durable_work(key,kind,payload,owner_id)
    SELECT 'reconcile:' || id || ':' || txid_current()::text,'RECONCILE','{}',id FROM users WHERE role='CLIENT'
    ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER durable_achievement_catalog AFTER INSERT OR UPDATE ON achievements FOR EACH ROW EXECUTE FUNCTION exom_queue_achievement_catalog();
