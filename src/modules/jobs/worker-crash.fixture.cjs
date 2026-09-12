// Local PostgreSQL fixture: exits without finally/disconnect after JobsService claims.
require('ts-node/register/transpile-only');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');
const { assertTestDatabase, databaseUrl } = require('../../../scripts/test-database.cjs');
const { JobsService } = require('./jobs.service');
(async () => {
  const pool = new Pool({ connectionString: databaseUrl() });
  await assertTestDatabase(pool);
  const db = new PrismaClient({ adapter: new PrismaPg(pool) });
  Object.assign(db, { postgresqlPool: pool });
  const jobs = new JobsService(db);
  jobs.register('CRASH_RECOVERY', async () => {
    process.stdin.once('data', () => process.exit(23));
    process.stdout.write('CLAIMED\n');
    await new Promise(() => {});
  });
  await jobs.runKey(process.argv[2]);
})().catch(() => {
  process.stderr.write('FIXTURE_FAILED\n');
  process.exit(1);
});
