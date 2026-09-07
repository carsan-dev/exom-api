-- Visibility only. Existing clients keep their account state and history.
ALTER TABLE "users" ADD COLUMN "is_archived" BOOLEAN NOT NULL DEFAULT false;
