const assert = require('node:assert/strict');
const NAME = 'exom-p4-t1-ci-20260928';
function assertContainer(c) {
  assert.equal(c.Name, `/${NAME}`);
  assert.equal(c.Config?.Image, 'postgres:17');
  assert.equal(c.Config?.Labels?.['exom.scope'], 'p4-t1-20260928');
  assert.equal(c.State?.Running, true);
  assert.deepEqual(c.NetworkSettings?.Ports?.['5432/tcp'], [{ HostIp: '127.0.0.1', HostPort: '55493' }]);
  assert.equal(c.Mounts?.length, 2);
  assert.ok(c.Mounts.every(m => m.Type === 'volume'));
  assert.ok(c.Mounts.some(m => m.Name === `${NAME}-data` && m.Destination === '/var/lib/postgresql/exom-ci-data'));
  const env = c.Config?.Env || [];
  for (const key of ['POSTGRES_DB=exom_ci', 'POSTGRES_USER=exom_ci',
    'PGDATA=/var/lib/postgresql/exom-ci-data']) assert.ok(env.includes(key));
}
function assertTarget(url, env) {
  const parsed = new URL(url);
  assert.equal(parsed.protocol, 'postgresql:');
  assert.equal(parsed.hostname, '127.0.0.1');
  assert.equal(parsed.port, '55493');
  assert.equal(parsed.pathname, '/exom_ci');
  assert.equal(parsed.username, 'exom_ci');
  assert.equal(parsed.search, '');
  assert.equal(parsed.hash, '');
  for (const key of ['TEST_DATABASE_URL', 'DATABASE_URL', 'PRISMA_DATABASE_URL', 'DIRECT_URL']) {
    assert.equal(env[key], url);
  }
}
function assertLegacy(names, count) {
  assert.equal(names.length, 79);
  assert.equal(count, 0);
  assert.equal(new Set(names).size, 79);
  assert.ok(!names.includes('20260928210000_adherence_configuration'));
}
function assertRecoveryName(name) {
  assert.match(name, /^exom_ci_p4_t1_recovery_[a-f0-9]{12}$/);
}
function assertCliName(name) {
  assert.match(name, /^exom_ci_p4_t1_cli_[a-f0-9]{12}$/);
}
function cliTarget(primaryUrl, name, env) {
  assertCliName(name);
  assertTarget(primaryUrl, env);
  const url = new URL(primaryUrl);
  url.pathname = `/${name}`;
  const scoped = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME',
    'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'LANG']) {
    if (env[key] !== undefined) scoped[key] = env[key];
  }
  for (const key of ['PRISMA_DATABASE_URL', 'DATABASE_URL', 'DIRECT_URL']) scoped[key] = url.toString();
  return scoped;
}
function deployCli(primaryUrl, name, env, runner = spawnSync) {
  const scoped = cliTarget(primaryUrl, name, env);
  // Fail closed if the Prisma config stops selecting the scoped CLI-only URL.
  const config = fs.readFileSync(path.join(ROOT, 'prisma.config.ts'), 'utf8');
  assert.ok(config.includes('url: process.env["PRISMA_DATABASE_URL"] ?? process.env["DATABASE_URL"]'),
    'Prisma CLI datasource configuration changed');
  const cli = path.join(ROOT, 'node_modules', 'prisma', 'build', 'index.js');
  assert.ok(fs.existsSync(cli), 'Local Prisma CLI not installed');
  const result = runner(process.execPath, [cli, 'migrate', 'deploy'], {
    cwd: ROOT, env: scoped, stdio: ['ignore', 'pipe', 'pipe'], encoding: null,
    windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  });
  assert.ok(!result.error && result.status === 0, 'Prisma migrate deploy failed (output suppressed)');
}
function assertDatabaseInventory(names) {
  const base = ['exom_ci', 'postgres', 'template0', 'template1'];
  assert.equal(new Set(names).size, names.length);
  for (const name of base) assert.ok(names.includes(name), `Missing expected database ${name}`);
  for (const name of names) {
    assert.ok(base.includes(name) || /^exom_ci_p4_t1_(?:source|recovery|cli)_[a-f0-9]{12}$/.test(name),
      `Unexpected database ${name}`);
  }
}
const CONSTRAINTS = [
  'adherence_config_epochs_pkey', 'adherence_config_heads_pkey',
  'adherence_config_heads_version_check', 'adherence_config_revisions_pkey',
  'adherence_config_revisions_steps_goal_check', 'adherence_config_revisions_percent_check',
  'adherence_config_heads_client_id_fkey', 'adherence_config_revisions_client_id_fkey',
];
const INDEXES = [
  'adherence_config_epochs_pkey', 'adherence_config_heads_pkey',
  'adherence_config_revisions_pkey', 'adherence_config_revisions_client_id_version_key',
  'adherence_config_revisions_client_id_effective_date_key',
  'adherence_config_revisions_client_id_effective_date_idx',
];
async function assertRecoverySchema(pool, clientId, revisionId) {
  const constraints = (await pool.query(`SELECT c.conname AS name FROM pg_constraint c
    JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public'
    AND c.conrelid IN ('adherence_config_epochs'::regclass,
      'adherence_config_heads'::regclass, 'adherence_config_revisions'::regclass)`)).rows;
  for (const name of CONSTRAINTS) assert.ok(constraints.some(row => row.name === name), `Missing constraint ${name}`);
  const indexes = (await pool.query(`SELECT i.relname AS name, x.indisvalid AS valid FROM pg_index x
    JOIN pg_class i ON i.oid=x.indexrelid JOIN pg_namespace n ON n.oid=i.relnamespace
    WHERE n.nspname='public' AND x.indrelid IN ('adherence_config_epochs'::regclass,
      'adherence_config_heads'::regclass, 'adherence_config_revisions'::regclass)`)).rows;
  for (const name of INDEXES) assert.ok(indexes.some(row => row.name === name && row.valid), `Missing valid index ${name}`);
  const insert = `INSERT INTO adherence_config_revisions(id,client_id,version,effective_date,steps_goal,
    calorie_lower_percent,calorie_upper_percent,protein_min_percent,steps_min_percent,low_global_percent)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`;
  await rejected(pool, `INSERT INTO adherence_config_heads(client_id,version) VALUES($1,-1)`, [clientId], '23514');
  await rejected(pool, `INSERT INTO adherence_config_heads(client_id,version) VALUES($1,0)`, ['unknown-user'], '23503');
  const valid = [revisionId, clientId, 1, '2026-09-29', 8000, 10, 10, 90, 100, 80];
  await rejected(pool, insert, [`invalid-step-${revisionId}`, ...valid.slice(1, 4), 0, ...valid.slice(5)], '23514');
  await rejected(pool, insert, [`invalid-percent-${revisionId}`, ...valid.slice(1, 5), 101, ...valid.slice(6)], '23514');
  await rejected(pool, insert, valid, '23505');
  await rejected(pool, insert, [`duplicate-version-${revisionId}`, ...valid.slice(1)], '23505');
  await rejected(pool, insert, [`duplicate-date-${revisionId}`, clientId, 2, ...valid.slice(3)], '23505');
  await rejected(pool, insert, [`orphan-${revisionId}`, 'unknown-user', 2, ...valid.slice(3)], '23503');
}
module.exports = { assertContainer, assertTarget, assertLegacy, assertRecoveryName,
  assertDatabaseInventory, assertRecoverySchema, cliTarget, deployCli };

// Dedicated databases and an in-memory dump: no temporary filesystem copies or cleanup.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { Pool } = require('pg');
const { databaseUrl } = require('./test-database.cjs');
const MIGRATION = '20260928210000_adherence_configuration';
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = '/var/lib/postgresql/exom-ci-data';
function execDocker(args, input) {
  const result = spawnSync('docker', args, { cwd: ROOT, input, encoding: null,
    windowsHide: true, maxBuffer: 128 * 1024 * 1024 });
  // stderr and subprocess errors can contain connection strings; never echo them.
  assert.ok(!result.error && result.status === 0, `Docker ${args[0]} failed`);
  return result.stdout;
}
function forDatabase(url, name) {
  const value = new URL(url);
  value.pathname = `/${name}`;
  return new Pool({ connectionString: value.toString(), connectionTimeoutMillis: 5000, ssl: false });
}
async function identity(pool, name) {
  const { rows: [found] } = await pool.query(`SELECT current_database() AS db, current_user AS role,
    current_setting('data_directory') AS directory, inet_server_port() AS port`);
  assert.deepEqual(found, { db: name, role: 'exom_ci', directory: DATA_DIR, port: 5432 });
}
async function one(pool, table, id) {
  const result = await pool.query(`SELECT to_jsonb(t) AS item FROM ${table} t WHERE id=$1`, [id]);
  assert.equal(result.rows.length, 1, `Missing synthetic ${table} fixture`);
  return result.rows[0].item;
}
async function rejected(pool, sql, parameters, code) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await assert.rejects(client.query(sql, parameters), error => error.code === code);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}
async function main() {
  const url = databaseUrl();
  assertTarget(url, process.env);
  const inspected = JSON.parse(execDocker(['inspect', NAME]).toString('utf8'));
  assert.equal(inspected.length, 1);
  assertContainer(inspected[0]);
  // Never trust a .env or an ambient Prisma alias when performing DB writes.
  execDocker(['exec', NAME, 'pg_isready', '-U', 'exom_ci', '-d', 'exom_ci']);
  const primary = forDatabase(url, 'exom_ci');
  let source;
  let restored;
  let cliClone;
  let sourceName;
  let recoveryName;
  let cliName;
  try {
    await identity(primary, 'exom_ci');
    const current = (await primary.query(`SELECT migration_name, checksum FROM _prisma_migrations
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`)).rows;
    const directory = path.join(ROOT, 'prisma', 'migrations');
    const migrations = fs.readdirSync(directory).filter(name => fs.existsSync(path.join(directory, name, 'migration.sql'))).sort();
    assert.equal(migrations.length, 80);
    assert.equal(migrations.at(-1), MIGRATION);
    assert.deepEqual(current.map(row => row.migration_name), migrations);
    const files = migrations.map(name => fs.readFileSync(path.join(directory, name, 'migration.sql')));
    current.forEach((row, index) => assert.equal(row.checksum, crypto.createHash('sha256').update(files[index]).digest('hex')));
    const databases = (await primary.query('SELECT datname FROM pg_database')).rows.map(row => row.datname).sort();
    assertDatabaseInventory(databases);
    console.log('PASS isolated container, 80 primary migration checksums and bounded database namespace');

    // Each test run owns fresh random names. Keep both on failure for forensic inspection.
    const suffix = crypto.randomBytes(6).toString('hex');
    sourceName = `exom_ci_p4_t1_source_${suffix}`;
    recoveryName = `exom_ci_p4_t1_recovery_${suffix}`;
    cliName = `exom_ci_p4_t1_cli_${suffix}`;
    assertRecoveryName(recoveryName);
    assertCliName(cliName);
    assert.match(sourceName, /^exom_ci_p4_t1_source_[a-f0-9]{12}$/);
    for (const name of [sourceName, recoveryName, cliName]) {
      assert.equal((await primary.query('SELECT count(*)::int AS n FROM pg_database WHERE datname=$1', [name])).rows[0].n, 0);
    }
    await primary.query(`CREATE DATABASE "${sourceName}"`);
    source = forDatabase(url, sourceName);
    await identity(source, sourceName);
    await source.query(`CREATE TABLE _prisma_migrations (
      id VARCHAR(36) PRIMARY KEY, checksum VARCHAR(64) NOT NULL,
      finished_at TIMESTAMPTZ, migration_name VARCHAR(255) NOT NULL,
      logs TEXT, rolled_back_at TIMESTAMPTZ, started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      applied_steps_count INTEGER NOT NULL DEFAULT 0)`);
    for (let index = 0; index < 79; index++) {
      await source.query(files[index].toString('utf8'));
      await source.query(`INSERT INTO _prisma_migrations(id,checksum,finished_at,migration_name,applied_steps_count)
        VALUES($1,$2,now(),$3,1)`, [crypto.randomUUID(), current[index].checksum, migrations[index]]);
    }
    const prior = (await source.query('SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name')).rows.map(r => r.migration_name);
    const relationCount = (await source.query(`SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname LIKE 'adherence_config_%'`)).rows[0].n;
    assert.deepEqual(prior, migrations.slice(0, 79));
    assertLegacy(prior, relationCount);

    const id = `p4-synthetic-${suffix}`;
    const admin = `p4-coach-${suffix}`;
    const fixture = {
      users: id, profiles: `p4-profile-${suffix}`, admin_client_assignments: `p4-assignment-${suffix}`,
      day_progress: `p4-progress-${suffix}`, weekly_recaps: `p4-recap-${suffix}`,
    };
    await source.query(`INSERT INTO users(id,email,firebase_uid,updated_at)
      VALUES($1,$2,$1,now()),($3,$4,$3,now())`, [id, `client-${suffix}@example.test`, admin, `coach-${suffix}@example.test`]);
    await source.query(`INSERT INTO profiles(id,user_id,first_name,last_name,target_calories,updated_at)
      VALUES($1,$2,'Synthetic','Legacy',1900,now())`, [fixture.profiles, id]);
    await source.query(`INSERT INTO admin_client_assignments(id,admin_id,client_id,is_active)
      VALUES($1,$2,$3,true)`, [fixture.admin_client_assignments, admin, id]);
    await source.query(`INSERT INTO day_progress(id,client_id,date,training_completed,trainings_completed,
      exercises_completed,meals_completed,notes,updated_at)
      VALUES($1,$2,'2026-09-21',true,ARRAY['legacy-training']::text[],$3::jsonb,
        ARRAY['legacy-meal']::text[],'Synthetic daily note',now())`,
    [fixture.day_progress, id, JSON.stringify([{ training_id: 'legacy-training', sets: [{ seconds: 45, rir: 0 }] }])]);
    await source.query(`INSERT INTO weekly_recaps(id,client_id,week_start_date,week_end_date,
      average_daily_steps,admin_comments,updated_at)
      VALUES($1,$2,'2026-09-21','2026-09-27',7600,'Synthetic coach recap',now())`, [fixture.weekly_recaps, id]);
    const before = {};
    for (const [table, key] of Object.entries(fixture)) before[table] = await one(source, table, key);
    before.coach = await one(source, 'users', admin);
    assert.equal(before.profiles.target_calories, 1900);
    // Intentional behavior-level RED: the legacy fixture must not contain the new epoch.
    const epochBefore = await source.query(`SELECT to_regclass('public.adherence_config_epochs') AS relation`);
    assert.equal(epochBefore.rows[0].relation, null);
    assert.throws(() => assert.equal(epochBefore.rows[0].relation, 'adherence_config_epochs'),
      { code: 'ERR_ASSERTION' });
    console.log('RED observed: pre-P4 fixture fails the epoch-availability assertion');

    // Clone the exact pre-P4 fixture before any manual application of migration 80.
    const legacyDump = execDocker(['exec', NAME, 'pg_dump', '-U', 'exom_ci', '-d', sourceName,
      '-Fc', '--no-owner', '--no-acl']);
    assert.ok(legacyDump.length > 100);
    await primary.query(`CREATE DATABASE "${cliName}"`);
    cliClone = forDatabase(url, cliName);
    await identity(cliClone, cliName);
    execDocker(['exec', '-i', NAME, 'pg_restore', '-U', 'exom_ci', '-d', cliName,
      '--no-owner', '--no-acl'], legacyDump);
    const records = `SELECT migration_name,checksum,finished_at,rolled_back_at FROM _prisma_migrations ORDER BY migration_name`;
    assert.deepEqual((await cliClone.query(records)).rows, (await source.query(records)).rows);
    assertLegacy((await cliClone.query(records)).rows.map(row => row.migration_name),
      (await cliClone.query(`SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relname LIKE 'adherence_config_%'`)).rows[0].n);
    for (const [table, key] of Object.entries(fixture)) assert.deepEqual(await one(cliClone, table, key), before[table]);
    assert.deepEqual(await one(cliClone, 'users', admin), before.coach);
    const primaryBefore = (await primary.query(records)).rows;
    deployCli(url, cliName, process.env);
    assert.deepEqual((await primary.query(records)).rows, primaryBefore, 'Prisma CLI changed primary migration history');
    const cliRecords = (await cliClone.query(records)).rows;
    assert.deepEqual(cliRecords.map(row => row.migration_name), migrations);
    cliRecords.forEach((row, index) => {
      assert.equal(row.checksum, current[index].checksum);
      assert.ok(row.finished_at && !row.rolled_back_at, `CLI migration ${index + 1} not completed`);
    });
    const today = (await source.query(`SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date::text AS date`)).rows[0].date;
    const expectedEpoch = [{ id: 'default', date: today }];
    assert.deepEqual((await cliClone.query(`SELECT id,effective_date::text AS date FROM adherence_config_epochs`)).rows, expectedEpoch);
    for (const table of ['adherence_config_revisions', 'adherence_config_heads']) {
      assert.equal((await cliClone.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 0);
    }
    for (const [table, key] of Object.entries(fixture)) assert.deepEqual(await one(cliClone, table, key), before[table]);
    assert.deepEqual(await one(cliClone, 'users', admin), before.coach);
    const cliRevision = `p4-cli-config-${suffix}`;
    await cliClone.query('INSERT INTO adherence_config_heads(client_id,version) VALUES($1,0)', [id]);
    await cliClone.query(`INSERT INTO adherence_config_revisions(id,client_id,version,effective_date,steps_goal,
      calorie_lower_percent,calorie_upper_percent,protein_min_percent,steps_min_percent,low_global_percent)
      VALUES($1,$2,1,'2026-09-29',8000,10,10,90,100,80)`, [cliRevision, id]);
    await assertRecoverySchema(cliClone, id, cliRevision);
    console.log('PASS Prisma migrate deploy on isolated pre-P4 CLI clone; 80 checksums, unchanged historical rows, epoch and schema behavior');

    await source.query(files[79].toString('utf8'));
    await source.query(`INSERT INTO _prisma_migrations(id,checksum,finished_at,migration_name,applied_steps_count)
      VALUES($1,$2,now(),$3,1)`, [crypto.randomUUID(), current[79].checksum, MIGRATION]);
    const epoch = (await source.query(`SELECT id,effective_date::text AS date FROM adherence_config_epochs`)).rows;
    assert.deepEqual(epoch, expectedEpoch);
    assert.equal((await source.query(`SELECT count(*)::int AS n FROM adherence_config_revisions`)).rows[0].n, 0);
    assert.equal((await source.query(`SELECT count(*)::int AS n FROM adherence_config_heads`)).rows[0].n, 0);
    for (const [table, key] of Object.entries(fixture)) assert.deepEqual(await one(source, table, key), before[table]);
    assert.deepEqual(await one(source, 'users', admin), before.coach);
    const revision = `p4-config-${suffix}`;
    const insertRevision = `INSERT INTO adherence_config_revisions(id,client_id,version,effective_date,steps_goal,
      calorie_lower_percent,calorie_upper_percent,protein_min_percent,steps_min_percent,low_global_percent)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`;
    await source.query('INSERT INTO adherence_config_heads(client_id,version) VALUES($1,0)', [id]);
    await source.query(insertRevision, [revision, id, 1, '2026-09-29', 8000, 10, 10, 90, 100, 80]);
    await rejected(source, insertRevision, [`invalid-${suffix}`, id, 2, '2026-09-30', 0, 10, 10, 90, 100, 80], '23514');
    await rejected(source, insertRevision, [`duplicate-${suffix}`, id, 1, '2026-09-30', 8000, 10, 10, 90, 100, 80], '23505');
    await rejected(source, insertRevision, [`orphan-${suffix}`, 'unknown-user', 1, '2026-09-30', 8000, 10, 10, 90, 100, 80], '23503');
    assert.equal((await source.query(`SELECT count(*)::int AS n FROM adherence_config_revisions`)).rows[0].n, 1);
    console.log('GREEN P4 epoch, untouched legacy rows and SQL checks, uniqueness and foreign keys');

    const dump = execDocker(['exec', NAME, 'pg_dump', '-U', 'exom_ci', '-d', sourceName,
      '-Fc', '--no-owner', '--no-acl']);
    assert.ok(dump.length > 100);
    await primary.query(`CREATE DATABASE "${recoveryName}"`);
    restored = forDatabase(url, recoveryName);
    await identity(restored, recoveryName);
    execDocker(['exec', '-i', NAME, 'pg_restore', '-U', 'exom_ci', '-d', recoveryName,
      '--no-owner', '--no-acl'], dump);
    for (const [table, key] of Object.entries(fixture)) assert.deepEqual(await one(restored, table, key), await one(source, table, key));
    assert.deepEqual(await one(restored, 'users', admin), before.coach);
    assert.deepEqual(await one(restored, 'adherence_config_revisions', revision), await one(source, 'adherence_config_revisions', revision));
    assert.deepEqual((await restored.query('SELECT id,effective_date::text AS date FROM adherence_config_epochs')).rows, epoch);
    assert.deepEqual((await restored.query(records)).rows, (await source.query(records)).rows);
    await assertRecoverySchema(restored, id, revision);
    console.log('PASS pg_dump/pg_restore into separate named recovery database; all 80 migration records, fixtures and schema behavior match');
  } catch {
    console.error('FAIL isolated P4 upgrade/recovery; databases retained for inspection, no cleanup performed');
    process.exitCode = 1;
  } finally {
    await restored?.end();
    await cliClone?.end();
    await source?.end();
    await primary.end();
    if (sourceName) console.log(`Isolated source database retained: ${sourceName}`);
    if (recoveryName) console.log(`Isolated recovery database (if created) retained: ${recoveryName}`);
    if (cliName) console.log(`Isolated CLI database (if created) retained: ${cliName}`);
  }
}
if (require.main === module) main().catch(() => {
  console.error('FAIL isolated P4 harness preflight; no destructive cleanup performed');
  process.exitCode = 1;
});
