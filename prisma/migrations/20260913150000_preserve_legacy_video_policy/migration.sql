-- Canonical links retain their existing monthly policy. Explicit legacy
-- backfill marks only new links so their old scalar-only exemption survives
-- future reconciliation without shifting another training's first-week anchor.
ALTER TABLE "plan_assignment_trainings"
ADD COLUMN "legacy_video_exempt" BOOLEAN NOT NULL DEFAULT false;
