UPDATE "mobile_app_config"
SET
  "android_store_url" = 'https://play.google.com/store/apps/details?id=com.exommethod.exom',
  "ios_store_url" = 'https://testflight.apple.com/'
WHERE "id" = 'default'
  AND (
    "android_store_url" = ''
    OR "android_store_url" = 'https://exommethod.com/app'
    OR "ios_store_url" = ''
    OR "ios_store_url" = 'https://exommethod.com/app'
  );
