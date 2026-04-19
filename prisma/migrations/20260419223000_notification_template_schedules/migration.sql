CREATE TABLE "notification_template_schedules" (
  "template_key" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "timezone" TEXT NOT NULL DEFAULT 'Europe/Madrid',
  "times" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "weekday" INTEGER,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "notification_template_schedules_pkey" PRIMARY KEY ("template_key")
);
