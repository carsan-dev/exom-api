CREATE TABLE "mobile_app_config" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "android_store_url" TEXT NOT NULL DEFAULT '',
    "ios_store_url" TEXT NOT NULL DEFAULT '',
    "latest_android_version" TEXT NOT NULL DEFAULT '',
    "latest_ios_version" TEXT NOT NULL DEFAULT '',
    "min_android_build" INTEGER NOT NULL DEFAULT 0,
    "min_ios_build" INTEGER NOT NULL DEFAULT 0,
    "recommended_android_build" INTEGER NOT NULL DEFAULT 0,
    "recommended_ios_build" INTEGER NOT NULL DEFAULT 0,
    "force_android_update" BOOLEAN NOT NULL DEFAULT false,
    "force_ios_update" BOOLEAN NOT NULL DEFAULT false,
    "update_title" TEXT NOT NULL DEFAULT 'Actualizacion disponible',
    "update_message" TEXT NOT NULL DEFAULT 'Hay una nueva version de EXOM disponible.',
    "support_url" TEXT NOT NULL DEFAULT '',
    "privacy_policy_url" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mobile_app_config_pkey" PRIMARY KEY ("id")
);
