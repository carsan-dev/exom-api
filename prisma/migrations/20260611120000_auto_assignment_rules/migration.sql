-- AlterTable
ALTER TABLE "plan_assignments" ADD COLUMN "auto_assignment_rule_id" TEXT;

-- CreateTable
CREATE TABLE "auto_assignment_rules" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "admin_id" TEXT,
    "source_week_start" DATE NOT NULL,
    "starts_on" DATE NOT NULL,
    "ends_on" DATE,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "deactivated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auto_assignment_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auto_assignment_rule_days" (
    "id" TEXT NOT NULL,
    "rule_id" TEXT NOT NULL,
    "weekday" INTEGER NOT NULL,
    "training_id" TEXT,
    "diet_id" TEXT,
    "is_rest_day" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "auto_assignment_rule_days_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "plan_assignments_auto_assignment_rule_id_idx" ON "plan_assignments"("auto_assignment_rule_id");

-- CreateIndex
CREATE INDEX "auto_assignment_rules_client_id_is_active_starts_on_ends_on_idx" ON "auto_assignment_rules"("client_id", "is_active", "starts_on", "ends_on");

-- CreateIndex
CREATE UNIQUE INDEX "auto_assignment_rule_days_rule_id_weekday_key" ON "auto_assignment_rule_days"("rule_id", "weekday");

-- AddForeignKey
ALTER TABLE "plan_assignments" ADD CONSTRAINT "plan_assignments_auto_assignment_rule_id_fkey" FOREIGN KEY ("auto_assignment_rule_id") REFERENCES "auto_assignment_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auto_assignment_rule_days" ADD CONSTRAINT "auto_assignment_rule_days_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "auto_assignment_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auto_assignment_rule_days" ADD CONSTRAINT "auto_assignment_rule_days_training_id_fkey" FOREIGN KEY ("training_id") REFERENCES "trainings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auto_assignment_rule_days" ADD CONSTRAINT "auto_assignment_rule_days_diet_id_fkey" FOREIGN KEY ("diet_id") REFERENCES "diets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
