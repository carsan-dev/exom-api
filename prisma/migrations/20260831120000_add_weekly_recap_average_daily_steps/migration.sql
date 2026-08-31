ALTER TABLE "weekly_recaps"
ADD COLUMN "average_daily_steps" INTEGER;

ALTER TABLE "weekly_recaps"
ADD CONSTRAINT "weekly_recaps_average_daily_steps_check"
CHECK ("average_daily_steps" IS NULL OR "average_daily_steps" BETWEEN 0 AND 200000);
