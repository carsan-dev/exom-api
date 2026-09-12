const { Pool } = require('pg');
// No dotenv or DATABASE_URL fallback: callers must identify a disposable service.
function databaseUrl() {
  const value = process.env.TEST_DATABASE_URL;
  if (!value) throw Error('TEST_DATABASE_URL required; integration cannot be skipped');
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
      url.hostname !== '127.0.0.1' || url.pathname !== '/exom_ci' ||
      url.username !== 'exom_ci' || !url.port || url.search || url.hash) {
    throw Error('Expected the local disposable exom_ci Docker service');
  }
  return value;
}
async function verifyDatabase() {
  const pool = new Pool({ connectionString: databaseUrl(), connectionTimeoutMillis: 3000 });
  try {
    await assertTestDatabase(pool);
    console.log('Isolated PostgreSQL identity verified');
  } finally { await pool.end(); }
}
async function assertTestDatabase(pool) {
  databaseUrl();
  const { rows: [identity] } = await pool.query(`SELECT current_database() AS database,
    current_user AS role, current_setting('data_directory') AS directory`);
  if (identity.database !== 'exom_ci' || identity.role !== 'exom_ci' ||
      identity.directory !== '/var/lib/postgresql/exom-ci-data') throw Error('Unexpected test cluster');
}
module.exports = { databaseUrl, verifyDatabase, assertTestDatabase };
if (require.main === module) verifyDatabase().catch(error => { console.error(error.message); process.exitCode = 1; });
