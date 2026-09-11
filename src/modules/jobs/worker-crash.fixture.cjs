// Local PostgreSQL fixture: exits without finally/disconnect after JobsService claims.
require('ts-node/register/transpile-only');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');
const { resolve } = require('node:path');
const { JobsService } = require('./jobs.service');
(async () => {
  const url = new URL(process.env.TEST_DATABASE_URL);
  if (
    url.hostname !== '127.0.0.1' ||
    url.port !== '55437' ||
    url.pathname !== '/exom_review'
  )
    throw Error('Not isolated');
  const pool = new Pool({ connectionString: url.toString() });
  const result = await pool.query('SHOW data_directory');
  if (
    resolve(result.rows[0].data_directory) !==
    resolve(process.cwd(), '../docs/operations/phase6-20260911/pgdata')
  )
    throw Error('Wrong cluster');
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
