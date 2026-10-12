// P3 legacy-upgrade/recovery check. Never use ambient database credentials.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { Pool } = require('pg');
const { databaseUrl } = require('./test-database.cjs');

const NAME = 'exom-training-p3-migration-20260923';
const MIGRATION = '20260923140000_training_session_rpe';
const ROOT = path.resolve(__dirname, '..');
const PORT = '55442';
function ensure(ok) { if (!ok) throw Error('Not the exact disposable target'); }
function assertContainer(c) {
  ensure(c.Name === `/${NAME}` && c.Config?.Image === 'postgres:17' &&
    c.Config?.Labels?.['exom.scope'] === 'p3-migration' && c.State?.Running === true);
  const ports = c.NetworkSettings?.Ports?.['5432/tcp'];
  ensure(ports?.length === 1 && ports[0].HostIp === '127.0.0.1' && ports[0].HostPort === PORT);
  const data = c.Mounts?.filter(m => m.Destination === '/var/lib/postgresql/exom-ci-data');
  // postgres:17 also declares an anonymous volume at /var/lib/postgresql/data.
  ensure(data?.length === 1 && data[0].Type === 'volume' && data[0].Name === `${NAME}-data` &&
    c.Mounts.length === 2 && c.Mounts.every(m => m.Type === 'volume' &&
      ['/var/lib/postgresql/data', '/var/lib/postgresql/exom-ci-data'].includes(m.Destination)));
  const env = Object.fromEntries((c.Config?.Env || []).map(entry => {
    const index = entry.indexOf('='); return [entry.slice(0, index), entry.slice(index + 1)];
  }));
  ensure(env.POSTGRES_DB === 'exom_ci' && env.POSTGRES_USER === 'exom_ci' &&
    env.PGDATA === '/var/lib/postgresql/exom-ci-data' && !!env.POSTGRES_PASSWORD);
  return env.POSTGRES_PASSWORD;
}
function assertEmptyCluster(databases, relations) {
  assert.deepEqual([...databases].sort(), ['exom_ci', 'postgres', 'template0', 'template1'], 'nonempty/preexisting cluster');
  assert.equal(relations.length, 0, 'nonempty/preexisting target');
}
function prismaEnvironment(url, ambient = process.env) {
  const parsed = new URL(url);
  ensure(parsed.protocol === 'postgresql:' && parsed.hostname === '127.0.0.1' &&
    parsed.port === PORT && parsed.username === 'exom_ci' && parsed.pathname === '/exom_ci' &&
    !parsed.search && !parsed.hash);
  return { ...ambient, DATABASE_URL: url, PRISMA_DATABASE_URL: url, DIRECT_URL: url,
    TEST_DATABASE_URL: url, DATABASE_SSL_MODE: 'disable', NODE_ENV: 'test' };
}
function run(binary, args, options = {}) {
  const result = spawnSync(binary, args, { cwd: ROOT, encoding: null, windowsHide: true,
    maxBuffer: 32 * 1024 * 1024, ...options });
  // Child output and errors can include a credential or ambient connection string.
  if (result.error || result.status !== 0) throw Error(`Isolated ${path.basename(binary)} subprocess failed`);
  return result.stdout;
}
function snapshot(pool, table, id) {
  return pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE id=$1`, [id]);
}
async function row(pool, table, id) {
  const rows = (await snapshot(pool, table, id)).rows;
  assert.equal(rows.length, 1, `Missing synthetic ${table} fixture`);
  return rows[0].row;
}
async function assertIdentity(pool, db) {
  const { rows: [identity] } = await pool.query(`SELECT current_database() AS db, current_user AS role,
    current_setting('data_directory') AS directory, inet_server_port() AS port`);
  assert.deepEqual(identity, { db, role: 'exom_ci', directory: '/var/lib/postgresql/exom-ci-data', port: 5432 });
}
async function main() {
  const inspected = JSON.parse(run('docker', ['inspect', NAME]).toString('utf8'));
  assert.equal(inspected.length, 1);
  const password = assertContainer(inspected[0]);
  const url = `postgresql://exom_ci:${encodeURIComponent(password)}@127.0.0.1:${PORT}/exom_ci`;
  const env = prismaEnvironment(url);
  const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 4000, ssl: false });
  let stage;
  let restoreName;
  try {
    // test-database.cjs validates TEST_DATABASE_URL; never read ambient production URLs.
    const priorTestUrl = process.env.TEST_DATABASE_URL;
    try {
      process.env.TEST_DATABASE_URL = url;
      assert.equal(databaseUrl(), url);
    } finally {
      if (priorTestUrl === undefined) delete process.env.TEST_DATABASE_URL;
      else process.env.TEST_DATABASE_URL = priorTestUrl;
    }
    run(process.execPath, [path.join(__dirname, 'test-database.cjs')], { env });
    await assertIdentity(pool, 'exom_ci');
    const databases = (await pool.query('SELECT datname FROM pg_database')).rows.map(r => r.datname);
    const relations = (await pool.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog','information_schema','pg_toast') AND c.relkind IN ('r','p','v','m','S','f')`)).rows;
    assertEmptyCluster(databases, relations);
    console.log('PASS isolated empty cluster guard');

    stage = fs.mkdtempSync(path.join(os.tmpdir(), 'exom-p3-upgrade-'));
    const migrations = path.join(stage, 'migrations');
    fs.mkdirSync(migrations);
    for (const entry of fs.readdirSync(path.join(ROOT, 'prisma', 'migrations'), { withFileTypes: true })) {
      if (entry.name === MIGRATION) continue;
      fs.cpSync(path.join(ROOT, 'prisma', 'migrations', entry.name), path.join(migrations, entry.name), { recursive: true });
    }
    const config = path.join(stage, 'prisma.config.ts');
    fs.writeFileSync(config, `export default { schema: ${JSON.stringify(path.join(ROOT, 'prisma/schema.prisma'))}, migrations: { path: ${JSON.stringify(migrations)} }, datasource: { url: process.env.PRISMA_DATABASE_URL } };\n`);
    const cli = path.join(ROOT, 'node_modules/prisma/build/index.js');
    run(process.execPath, [cli, 'migrate', 'deploy', '--config', config], { env });
    const columns = async (table, column) => (await pool.query(`SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1 AND column_name=$2`, [table, column])).rows[0].n;
    assert.equal(await columns('day_progress', 'training_sessions'), 0);
    assert.equal(await columns('feedback_media', 'training_session_id'), 0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM _prisma_migrations WHERE migration_name=$1', [MIGRATION])).rows[0].n, 0);
    console.log('PASS pre-P3 schema (new columns absent)');

    const id = 'p3-legacy-synthetic';
    await pool.query(`INSERT INTO users(id,email,firebase_uid,updated_at) VALUES($1,'p3-synthetic@example.test',$1,now())`, [id]);
    await pool.query(`INSERT INTO day_progress(id,client_id,date,training_completed,trainings_completed,exercises_completed,meals_completed,notes,updated_at)
      VALUES($1,$1,'2026-09-23',true,ARRAY['legacy-training']::text[], $2::jsonb, ARRAY[]::text[], 'Synthetic historical daily note', now())`,
      [id, JSON.stringify([{ training_id: 'legacy-training', training_exercise_id: 'legacy-exercise', completed: true,
        sets: [{ set_number: 1, seconds: 45, rir: 0, completed: true }] }])]);
    await pool.query(`INSERT INTO progress_operations(owner_id,id,date,payload_hash,response) VALUES($1,'p3-legacy-receipt','2026-09-23','synthetic-hash',$2::jsonb)`,
      [id, JSON.stringify({ revision: 1, training_completed: true })]);
    await pool.query(`INSERT INTO feedback_media(id,client_id,media_type,media_url,notes,updated_at)
      VALUES('p3-legacy-feedback',$1,'VIDEO','synthetic://legacy-video','Synthetic feedback',now())`, [id]);
    const before = {
      progress: await row(pool, 'day_progress', id),
      receipt: await row(pool, 'progress_operations', 'p3-legacy-receipt'),
      feedback: await row(pool, 'feedback_media', 'p3-legacy-feedback'),
      user: await row(pool, 'users', id),
    };
    assert.equal(before.progress.sync_revision, 1);
    run(process.execPath, [cli, 'migrate', 'deploy'], { env });
    assert.equal(await columns('day_progress', 'training_sessions'), 1);
    assert.equal(await columns('feedback_media', 'training_session_id'), 1);
    const upgraded = await row(pool, 'day_progress', id);
    assert.deepEqual(upgraded, { ...before.progress, training_sessions: [] });
    assert.deepEqual(await row(pool, 'feedback_media', 'p3-legacy-feedback'), { ...before.feedback, training_session_id: null });
    assert.deepEqual(await row(pool, 'progress_operations', 'p3-legacy-receipt'), before.receipt);
    assert.deepEqual(await row(pool, 'users', id), before.user);
    assert.equal(upgraded.exercises_completed[0].sets[0].seconds, 45);
    assert.equal(upgraded.exercises_completed[0].sets[0].rir, 0);
    await pool.query('UPDATE day_progress SET updated_at=now() WHERE id=$1', [id]);
    assert.equal((await row(pool, 'day_progress', id)).sync_revision, before.progress.sync_revision);
    await pool.query('UPDATE day_progress SET training_sessions=$2::jsonb WHERE id=$1', [id,
      JSON.stringify([{ training_id: 'legacy-training', training_session_id: 'synthetic-session', rpe: 5 }])]);
    assert.equal((await row(pool, 'day_progress', id)).sync_revision, before.progress.sync_revision + 1);
    await pool.query('UPDATE day_progress SET training_sessions=training_sessions WHERE id=$1', [id]);
    assert.equal((await row(pool, 'day_progress', id)).sync_revision, before.progress.sync_revision + 1);
    console.log('PASS legacy upgrade, preservation and session-only revision trigger');

    restoreName = `exom_ci_p3_recovery_${crypto.randomBytes(6).toString('hex')}`;
    // CREATE DATABASE is only permitted after exact empty-cluster guard; random name must not exist.
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM pg_database WHERE datname=$1', [restoreName])).rows[0].n, 0);
    const dump = run('docker', ['exec', NAME, 'pg_dump', '-U', 'exom_ci', '-d', 'exom_ci', '-Fc', '--no-owner', '--no-acl']);
    assert.ok(dump.length > 100);
    await pool.query(`CREATE DATABASE "${restoreName}"`);
    const restoredUrl = new URL(url); restoredUrl.pathname = `/${restoreName}`;
    run('docker', ['exec', '-i', NAME, 'pg_restore', '-U', 'exom_ci', '-d', restoreName, '--no-owner', '--no-acl'], { input: dump });
    const restored = new Pool({ connectionString: restoredUrl.toString(), connectionTimeoutMillis: 4000, ssl: false });
    try {
      await assertIdentity(restored, restoreName);
      for (const [table, key] of [['users', id], ['day_progress', id],
        ['progress_operations', 'p3-legacy-receipt'], ['feedback_media', 'p3-legacy-feedback']]) {
        assert.deepEqual(await row(restored, table, key), await row(pool, table, key));
      }
      const sql = 'SELECT migration_name,checksum,finished_at,rolled_back_at FROM _prisma_migrations WHERE migration_name=$1';
      const sourceRecord = (await pool.query(sql, [MIGRATION])).rows;
      assert.equal(sourceRecord.length, 1);
      assert.ok(sourceRecord[0].finished_at && !sourceRecord[0].rolled_back_at);
      assert.deepEqual((await restored.query(sql, [MIGRATION])).rows, sourceRecord);
      console.log('PASS pg_dump/pg_restore rows and P3 migration record');
    } finally { await restored.end(); }
  } catch (error) {
    // Deliberately omit exception details: driver/CLI messages may include connection strings.
    console.error(`FAIL P3 upgrade/recovery; isolated fixture retained in ${NAME}`);
    console.error('Inspect only this container and its uniquely named recovery DB; do not reset or drop it.');
    process.exitCode = 1;
  } finally {
    await pool.end();
    if (stage) console.log(`Temporary pre-P3 migration copy retained at ${stage}`);
    if (restoreName) console.log(`Isolated recovery database retained: ${restoreName}`);
  }
}
module.exports = { assertContainer, assertEmptyCluster, prismaEnvironment };
if (require.main === module) main().catch(() => {
  console.error('FAIL isolated P3 harness initialization; no destructive cleanup performed');
  process.exitCode = 1;
});
