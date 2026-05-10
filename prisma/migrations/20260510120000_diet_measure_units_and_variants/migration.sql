ALTER TYPE "MeasureUnit" ADD VALUE IF NOT EXISTS 'tablespoon';
ALTER TYPE "MeasureUnit" ADD VALUE IF NOT EXISTS 'teaspoon';
ALTER TYPE "MeasureUnit" ADD VALUE IF NOT EXISTS 'handful';
ALTER TYPE "MeasureUnit" ADD VALUE IF NOT EXISTS 'glass';
ALTER TYPE "MeasureUnit" ADD VALUE IF NOT EXISTS 'cup';
ALTER TYPE "MeasureUnit" ADD VALUE IF NOT EXISTS 'pinch';
ALTER TYPE "MeasureUnit" ADD VALUE IF NOT EXISTS 'serving';
ALTER TYPE "MeasureUnit" ADD VALUE IF NOT EXISTS 'to_taste';

ALTER TABLE "meals" ADD COLUMN "parent_meal_id" TEXT;

ALTER TABLE "meals"
  ADD CONSTRAINT "meals_parent_meal_id_fkey"
  FOREIGN KEY ("parent_meal_id") REFERENCES "meals"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "meals_parent_meal_id_idx" ON "meals"("parent_meal_id");
