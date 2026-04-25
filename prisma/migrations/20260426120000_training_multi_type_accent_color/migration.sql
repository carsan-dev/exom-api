ALTER TABLE "trainings"
ADD COLUMN "types" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "accentColor" TEXT;

UPDATE "trainings"
SET "types" = ARRAY["type"]::TEXT[]
WHERE
  COALESCE(array_length("types", 1), 0) = 0
  AND BTRIM("type") <> '';
