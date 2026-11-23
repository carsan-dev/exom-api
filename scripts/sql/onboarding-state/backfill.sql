-- Onboarding state backfill (plan OP-D4/OP-D12). Run through
-- scripts/onboarding-state-backfill.cjs (dry-run by default, --apply explicit).
-- Marks CLIENT profiles with real App activity as already onboarded:
-- an FCM token, any day_progress row or any body_metrics row.
-- onboarding_outcome stays NULL (unknown); updated_at is not touched.
-- Prisma stores DateTime as UTC in TIMESTAMP(3) columns, so the instant is
-- converted explicitly instead of depending on the session TimeZone.
-- Idempotent: already marked profiles (including endpoint marks) are skipped,
-- and PostgreSQL re-checks the predicate after waiting on a locked row.
UPDATE profiles p
   SET onboarding_completed_at = (now() AT TIME ZONE 'UTC')
  FROM users u
 WHERE p.user_id = u.id
   AND u.role = 'CLIENT'
   AND p.onboarding_completed_at IS NULL
   AND (u.fcm_token IS NOT NULL
        OR EXISTS (SELECT 1 FROM day_progress d WHERE d.client_id = u.id)
        OR EXISTS (SELECT 1 FROM body_metrics b WHERE b.client_id = u.id));
