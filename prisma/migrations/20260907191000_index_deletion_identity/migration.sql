-- Pending identity lookup in the User write barrier; completed rows clear UID.
CREATE INDEX "client_deletions_firebase_uid_idx" ON "client_deletions"("firebase_uid");
