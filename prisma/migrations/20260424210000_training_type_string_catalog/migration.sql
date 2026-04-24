ALTER TABLE "trainings"
ALTER COLUMN "type" TYPE TEXT
USING "type"::TEXT;

DROP TYPE "TrainingType";
