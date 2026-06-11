UPDATE "mobile_app_config"
SET "ios_store_url" = 'https://apps.apple.com/es/app/exom/id6763056692'
WHERE "id" = 'default'
  AND (
    "ios_store_url" = ''
    OR "ios_store_url" = 'https://exommethod.com/app'
    OR "ios_store_url" = 'https://testflight.apple.com/'
    OR "ios_store_url" = 'https://apps.apple.com/app/6763056692'
  );
