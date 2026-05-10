ALTER TABLE "meal_ingredients"
  ADD COLUMN IF NOT EXISTS "grams_equivalent" DOUBLE PRECISION;
