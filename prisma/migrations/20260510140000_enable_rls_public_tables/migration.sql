-- Enable RLS on all application tables in the exposed public schema.
-- EXOM clients access data through exom-api + Firebase Auth, not Supabase
-- client-side table access. No anon/authenticated policies are added here.
--
-- Audit after applying:
-- SELECT schemaname, tablename, rowsecurity
-- FROM pg_tables
-- WHERE schemaname = 'public'
--   AND NOT rowsecurity
-- ORDER BY tablename;

ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "profiles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "admin_client_assignments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notification_templates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notification_template_schedules" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "approval_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "trainings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "exercises" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "training_exercises" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "diets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "meals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ingredients" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "meal_ingredients" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "plan_assignments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "day_progress" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "body_metrics" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "streaks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "weekly_recaps" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "challenges" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "challenge_clients" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "achievements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_achievements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "feedback_media" ENABLE ROW LEVEL SECURITY;
