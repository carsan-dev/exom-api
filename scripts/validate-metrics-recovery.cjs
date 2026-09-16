const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { databaseUrl, assertTestDatabase } = require('./test-database.cjs');
async function main() {
  const sourceUrl = databaseUrl();
  const targetUrl = new URL(sourceUrl); targetUrl.pathname = '/exom_ci_metrics_recovery';
  const source = new Pool({ connectionString: sourceUrl });
  const target = new Pool({ connectionString: targetUrl.toString() });
  try {
    await assertTestDatabase(source);
    const identity = (await target.query("SELECT current_database() AS db,current_user AS role,current_setting('data_directory') AS directory")).rows[0];
    assert.deepEqual(identity, { db: 'exom_ci_metrics_recovery', role: 'exom_ci', directory: '/var/lib/postgresql/exom-ci-data' });
    for (const table of ['weekly_recaps', 'body_metrics', 'day_progress']) {
      const sql = `SELECT to_jsonb(t) AS row FROM ${table} t WHERE id='p1-legacy'`;
      const original = (await source.query(sql)).rows;
      assert.equal(original.length, 1);
      assert.deepEqual((await target.query(sql)).rows, original);
    }
    assert.equal((await target.query("SELECT count(*)::int AS n FROM _prisma_migrations WHERE migration_name='20260916120000_recap_optional_habits' AND finished_at IS NOT NULL")).rows[0].n, 1);
    console.log('PASS pg_dump / pg_restore: migrated schema, legacy recap (including stress zero and NULL habits), body data and historical notes restored exactly');
  } finally { await source.end(); await target.end(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
