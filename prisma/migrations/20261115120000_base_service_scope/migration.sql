-- Servicio base: what each subscriber contracted (training, nutrition or both).
-- Additive: existing subscribers and deliveries get BOTH, exactly what they
-- were sent until now; no existing row is otherwise read or rewritten.
BEGIN;

CREATE TYPE "BaseServiceScope" AS ENUM ('TRAINING', 'NUTRITION', 'BOTH');

ALTER TABLE "base_subscribers"
    ADD COLUMN "service_scope" "BaseServiceScope" NOT NULL DEFAULT 'BOTH';

-- Part of the request snapshot, fixed when the delivery is created: retries
-- and resends of a delivery keep its scope even if the subscriber changes.
ALTER TABLE "base_deliveries"
    ADD COLUMN "snapshot_service_scope" "BaseServiceScope" NOT NULL DEFAULT 'BOTH';

-- Same trigger function as 20261114120000_base_service, with the new
-- snapshot column added to the immutable request snapshot.
CREATE OR REPLACE FUNCTION public.exom_base_delivery_snapshot_immutable() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."subscriber_id", NEW."month",
         NEW."snapshot_goal", NEW."snapshot_days_per_week", NEW."snapshot_service_scope",
         NEW."snapshot_order_code", NEW."files", NEW."requested_at")
     IS DISTINCT FROM
     ROW(OLD."subscriber_id", OLD."month",
         OLD."snapshot_goal", OLD."snapshot_days_per_week", OLD."snapshot_service_scope",
         OLD."snapshot_order_code", OLD."files", OLD."requested_at") THEN
    RAISE EXCEPTION 'base_deliveries request snapshot is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."send_seq" < OLD."send_seq" THEN
    RAISE EXCEPTION 'base_deliveries.send_seq cannot decrease' USING ERRCODE = 'check_violation';
  END IF;
  IF ROW(NEW."snapshot_name", NEW."snapshot_email") IS DISTINCT FROM ROW(OLD."snapshot_name", OLD."snapshot_email")
     AND NOT (NEW."send_seq" = OLD."send_seq" + 1 AND NEW."status" = 'PENDING') THEN
    RAISE EXCEPTION 'base_deliveries recipient changes only with a new send' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
-- CREATE OR REPLACE keeps the existing grants; restate the revoke anyway.
REVOKE EXECUTE ON FUNCTION public.exom_base_delivery_snapshot_immutable() FROM PUBLIC;

COMMIT;
