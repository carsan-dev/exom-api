CREATE TYPE "CatalogColorType" AS ENUM ('training_type', 'diet_nutritional_badge');

CREATE TABLE "catalog_colors" (
  "id" TEXT NOT NULL,
  "catalog_type" "CatalogColorType" NOT NULL,
  "normalized_key" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "color" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "catalog_colors_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "catalog_colors_catalog_type_normalized_key_key"
  ON "catalog_colors"("catalog_type", "normalized_key");

INSERT INTO "catalog_colors" ("id", "catalog_type", "normalized_key", "value", "color", "updated_at")
VALUES
  (gen_random_uuid()::text, 'training_type', 'fuerza', 'Fuerza', '#3B82F6', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'training_type', 'cardio', 'Cardio', '#F43F5E', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'training_type', 'hiit', 'HIIT', '#F97316', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'training_type', 'flexibilidad', 'Flexibilidad', '#A855F7', CURRENT_TIMESTAMP);
