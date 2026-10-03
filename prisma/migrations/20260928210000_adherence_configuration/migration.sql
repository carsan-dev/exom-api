-- No historical config is inferred from mutable profile fields.
-- Capture the UTC deployment/migration date once: defaults before this date are unknown.
CREATE TABLE "adherence_config_epochs" (
    "id" TEXT NOT NULL,
    "effective_date" DATE NOT NULL,
    CONSTRAINT "adherence_config_epochs_pkey" PRIMARY KEY ("id")
);
INSERT INTO "adherence_config_epochs" ("id", "effective_date")
VALUES ('default', (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date);
CREATE TABLE "adherence_config_heads" (
    "client_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "adherence_config_heads_pkey" PRIMARY KEY ("client_id"),
    CONSTRAINT "adherence_config_heads_version_check" CHECK ("version" >= 0)
);
CREATE TABLE "adherence_config_revisions" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "effective_date" DATE NOT NULL,
    "steps_goal" INTEGER,
    "calorie_lower_percent" INTEGER NOT NULL,
    "calorie_upper_percent" INTEGER NOT NULL,
    "protein_min_percent" INTEGER NOT NULL,
    "steps_min_percent" INTEGER NOT NULL,
    "low_global_percent" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "adherence_config_revisions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "adherence_config_revisions_steps_goal_check" CHECK ("steps_goal" IS NULL OR "steps_goal" > 0),
    CONSTRAINT "adherence_config_revisions_percent_check" CHECK (
      "calorie_lower_percent" BETWEEN 0 AND 100 AND "calorie_upper_percent" BETWEEN 0 AND 100
      AND "protein_min_percent" BETWEEN 0 AND 200 AND "steps_min_percent" BETWEEN 0 AND 200
      AND "low_global_percent" BETWEEN 0 AND 100)
);
CREATE UNIQUE INDEX "adherence_config_revisions_client_id_version_key" ON "adherence_config_revisions"("client_id", "version");
CREATE UNIQUE INDEX "adherence_config_revisions_client_id_effective_date_key" ON "adherence_config_revisions"("client_id", "effective_date");
CREATE INDEX "adherence_config_revisions_client_id_effective_date_idx" ON "adherence_config_revisions"("client_id", "effective_date" DESC);
ALTER TABLE "adherence_config_heads" ADD CONSTRAINT "adherence_config_heads_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "adherence_config_revisions" ADD CONSTRAINT "adherence_config_revisions_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
