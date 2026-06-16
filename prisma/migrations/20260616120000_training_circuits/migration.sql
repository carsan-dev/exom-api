CREATE TYPE "TrainingBlockType" AS ENUM ('CIRCUIT');

CREATE TABLE "training_blocks" (
  "id" TEXT NOT NULL,
  "training_id" TEXT NOT NULL,
  "order" INTEGER NOT NULL,
  "type" "TrainingBlockType" NOT NULL DEFAULT 'CIRCUIT',
  "name" TEXT,
  "rounds" INTEGER NOT NULL DEFAULT 3,
  "rest_between_rounds_seconds" INTEGER NOT NULL DEFAULT 60,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "training_blocks_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "training_exercises"
  ADD COLUMN "block_id" TEXT,
  ADD COLUMN "position_in_block" INTEGER;

CREATE UNIQUE INDEX "training_blocks_training_id_order_key"
  ON "training_blocks"("training_id", "order");

CREATE INDEX "training_blocks_training_id_order_idx"
  ON "training_blocks"("training_id", "order");

CREATE INDEX "training_exercises_block_id_position_in_block_idx"
  ON "training_exercises"("block_id", "position_in_block");

ALTER TABLE "training_blocks"
  ADD CONSTRAINT "training_blocks_training_id_fkey"
  FOREIGN KEY ("training_id") REFERENCES "trainings"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "training_exercises"
  ADD CONSTRAINT "training_exercises_block_id_fkey"
  FOREIGN KEY ("block_id") REFERENCES "training_blocks"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
