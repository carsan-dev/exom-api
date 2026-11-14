-- Servicio base: monthly PDF subscribers and their deliveries. Additive only:
-- no existing table, row or durable_work entry is read or rewritten.
BEGIN;

CREATE TYPE "BaseDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- Order codes come from a sequence: concurrent inserts never collide and a
-- rolled-back insert only leaves a gap. Codes keep at least six digits and
-- never truncate (lpad would cut 1000000 to 100000).
CREATE SEQUENCE "base_subscriber_order_seq" AS BIGINT START WITH 1 MINVALUE 1 MAXVALUE 9999999999999999 NO CYCLE;

CREATE FUNCTION public.exom_next_base_order_code() RETURNS TEXT
LANGUAGE sql VOLATILE AS $$
  SELECT 'EXB-' || CASE WHEN n < 1000000 THEN lpad(n::text, 6, '0') ELSE n::text END
  FROM (SELECT nextval('public.base_subscriber_order_seq') AS n) AS next_value
$$;

CREATE TABLE "base_subscribers" (
    "id" TEXT NOT NULL,
    "order_code" VARCHAR(20) NOT NULL DEFAULT exom_next_base_order_code(),
    "name" VARCHAR(80) NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "goal" VARCHAR(64) NOT NULL,
    "days_per_week" INTEGER NOT NULL,
    "notes" VARCHAR(2000),
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "archived_at" TIMESTAMPTZ(3),
    "created_by_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "base_subscribers_pkey" PRIMARY KEY ("id"),
    -- Same alphabet as normalizeOrderCode, so the stamp can never reject it.
    CONSTRAINT "base_subscribers_order_code_check" CHECK ("order_code" ~ '^[A-Z0-9_-]+$'),
    CONSTRAINT "base_subscribers_name_check" CHECK (length(btrim("name")) > 0),
    CONSTRAINT "base_subscribers_email_check" CHECK ("email" = lower(btrim("email")) AND position('@' IN "email") > 1),
    CONSTRAINT "base_subscribers_goal_check" CHECK ("goal" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
    CONSTRAINT "base_subscribers_days_check" CHECK ("days_per_week" BETWEEN 1 AND 7),
    CONSTRAINT "base_subscribers_archive_check" CHECK (
        ("is_archived" AND "archived_at" IS NOT NULL) OR (NOT "is_archived" AND "archived_at" IS NULL)
    ),
    CONSTRAINT "base_subscribers_created_by_id_fkey"
        FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "base_subscribers_order_code_key" ON "base_subscribers"("order_code");
-- One live subscriber per address; archived rows keep their history.
CREATE UNIQUE INDEX "base_subscribers_active_email_key" ON "base_subscribers"(lower("email")) WHERE NOT "is_archived";
CREATE INDEX "base_subscribers_archive_created_idx" ON "base_subscribers"("is_archived", "created_at", "id");

CREATE FUNCTION public.exom_base_subscriber_order_code_immutable() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."order_code" IS DISTINCT FROM OLD."order_code" THEN
    RAISE EXCEPTION 'base_subscribers.order_code is immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "base_subscribers_order_code_immutable" BEFORE UPDATE ON "base_subscribers"
    FOR EACH ROW EXECUTE FUNCTION public.exom_base_subscriber_order_code_immutable();

CREATE TABLE "base_deliveries" (
    "id" TEXT NOT NULL,
    "subscriber_id" TEXT NOT NULL,
    "month" INTEGER NOT NULL,
    "status" "BaseDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "send_seq" INTEGER NOT NULL DEFAULT 1,
    "snapshot_name" VARCHAR(80) NOT NULL,
    "snapshot_email" VARCHAR(254) NOT NULL,
    "snapshot_goal" VARCHAR(64) NOT NULL,
    "snapshot_days_per_week" INTEGER NOT NULL,
    "snapshot_order_code" VARCHAR(20) NOT NULL,
    "files" JSONB NOT NULL,
    "requested_by_id" TEXT,
    "requested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMPTZ(3),
    "provider_message_id" VARCHAR(200),
    "last_error" VARCHAR(64),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "base_deliveries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "base_deliveries_month_check" CHECK ("month" >= 1),
    CONSTRAINT "base_deliveries_send_seq_check" CHECK ("send_seq" >= 1),
    CONSTRAINT "base_deliveries_snapshot_days_check" CHECK ("snapshot_days_per_week" BETWEEN 1 AND 7),
    CONSTRAINT "base_deliveries_snapshot_order_code_check" CHECK ("snapshot_order_code" ~ '^[A-Z0-9_-]+$'),
    CONSTRAINT "base_deliveries_files_check" CHECK (jsonb_typeof("files") = 'array' AND jsonb_array_length("files") > 0),
    CONSTRAINT "base_deliveries_status_check" CHECK (
        ("status" = 'PENDING' AND "last_error" IS NULL)
        OR ("status" = 'SENT' AND "last_error" IS NULL AND "sent_at" IS NOT NULL AND "provider_message_id" IS NOT NULL)
        OR ("status" = 'FAILED' AND "last_error" IS NOT NULL)
    ),
    CONSTRAINT "base_deliveries_subscriber_id_fkey"
        FOREIGN KEY ("subscriber_id") REFERENCES "base_subscribers"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "base_deliveries_requested_by_id_fkey"
        FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- Backstop for the row-locked "next month" rule: one delivery per month.
CREATE UNIQUE INDEX "base_deliveries_subscriber_id_month_key" ON "base_deliveries"("subscriber_id", "month");

-- What was requested is history: later subscriber edits never rewrite it.
-- requested_by_id stays mutable only so ON DELETE SET NULL keeps working.
-- The recipient (snapshot_name, snapshot_email) belongs to each send and
-- mirrors the LATEST one: it may change only in the update that starts the
-- next send (send_seq + 1, back to PENDING), i.e. an explicit resend.
CREATE FUNCTION public.exom_base_delivery_snapshot_immutable() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."subscriber_id", NEW."month",
         NEW."snapshot_goal", NEW."snapshot_days_per_week", NEW."snapshot_order_code",
         NEW."files", NEW."requested_at")
     IS DISTINCT FROM
     ROW(OLD."subscriber_id", OLD."month",
         OLD."snapshot_goal", OLD."snapshot_days_per_week", OLD."snapshot_order_code",
         OLD."files", OLD."requested_at") THEN
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
CREATE TRIGGER "base_deliveries_snapshot_immutable" BEFORE UPDATE ON "base_deliveries"
    FOR EACH ROW EXECUTE FUNCTION public.exom_base_delivery_snapshot_immutable();

-- API-only access, like the other admin tables: RLS on, no client policies.
ALTER TABLE "base_subscribers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "base_deliveries" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "base_subscribers", "base_deliveries" FROM PUBLIC;
REVOKE ALL ON SEQUENCE "base_subscriber_order_seq" FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.exom_base_subscriber_order_code_immutable() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.exom_base_delivery_snapshot_immutable() FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
   REVOKE ALL ON TABLE "base_subscribers", "base_deliveries" FROM anon;
   REVOKE ALL ON SEQUENCE "base_subscriber_order_seq" FROM anon;
   REVOKE EXECUTE ON FUNCTION public.exom_next_base_order_code() FROM anon;
 END IF;
 IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
   REVOKE ALL ON TABLE "base_subscribers", "base_deliveries" FROM authenticated;
   REVOKE ALL ON SEQUENCE "base_subscriber_order_seq" FROM authenticated;
   REVOKE EXECUTE ON FUNCTION public.exom_next_base_order_code() FROM authenticated;
 END IF;
END $$;

COMMIT;
