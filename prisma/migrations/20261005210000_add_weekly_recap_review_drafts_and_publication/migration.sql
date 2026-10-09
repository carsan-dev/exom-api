-- Additive review storage only: legacy feedback, notes and lifecycle remain untouched.
-- No historical publication is inferred and no text is backfilled.
ALTER TABLE "weekly_recaps"
    ADD COLUMN "draft_coach_summary" TEXT,
    ADD COLUMN "draft_changes" TEXT,
    ADD COLUMN "draft_next_week_goals" TEXT,
    ADD COLUMN "published_coach_summary" TEXT,
    ADD COLUMN "published_changes" TEXT,
    ADD COLUMN "published_next_week_goals" TEXT,
    ADD COLUMN "review_version" INTEGER NOT NULL DEFAULT 0;
