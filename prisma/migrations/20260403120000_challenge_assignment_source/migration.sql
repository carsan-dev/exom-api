CREATE TYPE "ChallengeAssignmentSource" AS ENUM ('MANUAL', 'GLOBAL');

ALTER TABLE "challenge_clients"
ADD COLUMN "assignment_source" "ChallengeAssignmentSource" NOT NULL DEFAULT 'MANUAL';

CREATE INDEX "challenges_created_by_is_global_is_manual_type_created_at_idx"
ON "challenges"("created_by", "is_global", "is_manual", "type", "created_at");

CREATE INDEX "challenge_clients_client_id_is_completed_assigned_at_idx"
ON "challenge_clients"("client_id", "is_completed", "assigned_at");

CREATE INDEX "challenge_clients_challenge_id_assignment_source_client_id_idx"
ON "challenge_clients"("challenge_id", "assignment_source", "client_id");
