CREATE TABLE "training_groups" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalized_name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "training_groups_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "diet_groups" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalized_name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "diet_groups_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "trainings" ADD COLUMN "group_id" TEXT;
ALTER TABLE "diets" ADD COLUMN "group_id" TEXT;

CREATE UNIQUE INDEX "training_groups_normalized_name_key" ON "training_groups"("normalized_name");
CREATE UNIQUE INDEX "diet_groups_normalized_name_key" ON "diet_groups"("normalized_name");
CREATE INDEX "trainings_group_id_idx" ON "trainings"("group_id");
CREATE INDEX "diets_group_id_idx" ON "diets"("group_id");

ALTER TABLE "trainings" ADD CONSTRAINT "trainings_group_id_fkey"
  FOREIGN KEY ("group_id") REFERENCES "training_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "diets" ADD CONSTRAINT "diets_group_id_fkey"
  FOREIGN KEY ("group_id") REFERENCES "diet_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;
