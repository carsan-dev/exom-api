CREATE TYPE "AchievementUnlockSource" AS ENUM ('AUTOMATIC', 'MANUAL');

ALTER TABLE "user_achievements"
ADD COLUMN "unlock_source" "AchievementUnlockSource" NOT NULL DEFAULT 'AUTOMATIC';

CREATE INDEX "user_achievements_achievement_id_unlock_source_idx"
ON "user_achievements"("achievement_id", "unlock_source");
