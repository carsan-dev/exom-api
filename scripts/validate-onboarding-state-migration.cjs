// Fresh-install, upgrade, backfill and recovery check for the persistent
// onboarding state migration (plan OP-MIG-01..06 and -08).
// Runs only against the verified disposable exom_ci cluster (TEST_DATABASE_URL)
// and only inside databases it creates and drops itself. No ambient DATABASE_URL.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Pool } = require('pg');
const { databaseUrl, verifyDatabase } = require('./test-database.cjs');

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS = path.join(ROOT, 'prisma', 'migrations');
const TARGET = '20261123120000_profile_onboarding_state';
const SCOPE = /^exom_ci_onboarding_(?:upgrade|fresh|restore)_[a-f0-9]{12}$/;
const BACKFILL = path.join(__dirname, 'onboarding-state-backfill.cjs');
const ROLLBACK = path.join(__dirname, 'sql', 'onboarding-state', 'rollback.sql');
const NEW_COLUMNS = ['onboarding_completed_at', 'onboarding_outcome'];

function scopedUrl(name) {
  assert.match(name, SCOPE);
  const url = new URL(databaseUrl());
  url.pathname = `/${name}`;
  return url.toString();
}

function baseEnv() {
  const scoped = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP',
    'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'LANG']) {
    if (process.env[key] !== undefined) scoped[key] = process.env[key];
  }
  return scoped;
}

function prisma(args, url) {
  const config = fs.readFileSync(path.join(ROOT, 'prisma.config.ts'), 'utf8');
  assert.ok(config.includes('process.env["PRISMA_DATABASE_URL"] ?? process.env["DATABASE_URL"]'),
    'Prisma CLI datasource selection changed');
  const cli = path.join(ROOT, 'node_modules', 'prisma', 'build', 'index.js');
  // prisma.config.ts selects PRISMA_DATABASE_URL first; dotenv never overrides it.
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: ROOT, env: { ...baseEnv(), PRISMA_DATABASE_URL: url, DATABASE_URL: url },
    encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  });
  // Output can echo connection details: report only the status.
  assert.ok(!result.error && result.status === 0, `prisma ${args[0]} ${args[1] ?? ''} failed (${result.status})`);
}

function datamodelDrift(url) {
  // Schema-only SQL that would turn the migrated database into the datamodel.
  const cli = path.join(ROOT, 'node_modules', 'prisma', 'build', 'index.js');
  const result = spawnSync(process.execPath, [cli, 'migrate', 'diff', '--from-config-datasource',
    '--to-schema', path.join('prisma', 'schema.prisma'), '--script'], {
    cwd: ROOT, env: { ...baseEnv(), PRISMA_DATABASE_URL: url, DATABASE_URL: url },
    encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  });
  assert.ok(!result.error && result.status === 0, `prisma migrate diff failed (${result.status})`);
  return result.stdout.split('\n').filter((line) => line.trim() && !line.startsWith('--') &&
    !line.startsWith('Loaded Prisma config'));
}

function backfill(args, url) {
  const result = spawnSync(process.execPath, [BACKFILL, ...args], {
    cwd: ROOT, env: { ...baseEnv(), ONBOARDING_BACKFILL_DATABASE_URL: url },
    encoding: 'utf8', windowsHide: true,
  });
  const password = decodeURIComponent(new URL(url).password);
  for (const stream of [result.stdout, result.stderr]) {
    assert.ok(!stream.includes(url) && (!password || !stream.includes(password)),
      'backfill output must not expose the destination');
  }
  assert.ok(!result.error && result.status === 0, `backfill ${args.join(' ')} failed: ${result.stderr.trim()}`);
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
}

function migrationDirs() {
  return fs.readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

function assertTargetIsLatest() {
  const names = migrationDirs();
  assert.ok(names.includes(TARGET), `target migration ${TARGET} is missing`);
  assert.equal(names.at(-1), TARGET, 'target must be the latest migration');
}

async function applyLegacyMigrations(pool) {
  // Every migration before the target exactly as committed, recorded so that
  // `prisma migrate deploy` performs only the real upgrade step.
  const names = migrationDirs().filter((name) => name < TARGET);
  assert.ok(names.length > 0 && !names.includes(TARGET));
  for (const name of names) {
    await pool.query(fs.readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8'));
  }
  await pool.query(`CREATE TABLE "_prisma_migrations" (
    "id" VARCHAR(36) PRIMARY KEY NOT NULL, "checksum" VARCHAR(64) NOT NULL,
    "finished_at" TIMESTAMPTZ, "migration_name" VARCHAR(255) NOT NULL, "logs" TEXT,
    "rolled_back_at" TIMESTAMPTZ, "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "applied_steps_count" INTEGER NOT NULL DEFAULT 0)`);
  for (const name of names) {
    const sql = fs.readFileSync(path.join(MIGRATIONS, name, 'migration.sql'));
    await pool.query(`INSERT INTO "_prisma_migrations"
      (id, checksum, finished_at, migration_name, applied_steps_count)
      VALUES ($1, $2, now(), $3, 1)`,
    [crypto.randomUUID(), crypto.createHash('sha256').update(sql).digest('hex'), name]);
  }
  return names.length;
}

async function profileColumns(pool) {
  return (await pool.query(`SELECT column_name, data_type, udt_name, is_nullable, column_default
    FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'profiles'
      AND column_name = ANY($1) ORDER BY column_name`, [NEW_COLUMNS])).rows;
}

// F1..F8 exist before the migration; F9 is a client marked by the service UPDATE afterwards.
const F = Object.fromEntries(['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9']
  .map((key) => [key, `onboarding-${key}`]));

async function legacyFixtures(pool) {
  assert.deepEqual(await profileColumns(pool), [], 'fixtures must be written on the previous schema');
  const users = [
    [F.f1, 'CLIENT', 'fcm-f1'], [F.f2, 'CLIENT', null], [F.f3, 'CLIENT', null],
    [F.f4, 'CLIENT', null], [F.f5, 'ADMIN', 'fcm-f5'], [F.f6, 'SUPER_ADMIN', 'fcm-f6'],
    [F.f7, 'CLIENT', 'fcm-f7'], [F.f8, 'CLIENT', 'fcm-f8'], [F.f9, 'CLIENT', 'fcm-f9'],
  ];
  for (const [id, role, token] of users) {
    await pool.query(`INSERT INTO users (id, email, firebase_uid, role, fcm_token, updated_at)
      VALUES ($1, $1 || '@example.test', $1, $2::"Role", $3, '2026-01-02 03:04:05.678')`, [id, role, token]);
    if (id !== F.f8) {
      await pool.query(`INSERT INTO profiles (id, user_id, first_name, last_name, main_goal,
          current_weight, created_at, updated_at)
        VALUES ($1 || '-profile', $1, 'Fixture', $1, 'Fuerza', 70.5,
          '2026-01-01 00:00:00', '2026-01-02 03:04:05.678')`, [id]);
    }
  }
  for (const id of [F.f2, F.f6, F.f7, F.f8]) {
    await pool.query(`INSERT INTO day_progress (id, client_id, date, exercises_completed,
        meals_completed, trainings_completed, notes, updated_at)
      VALUES ($1 || '-day', $1, '2026-01-05', '[]', '{}', '{}', 'legacy', '2026-01-05 10:00:00')`, [id]);
  }
  for (const id of [F.f3, F.f7]) {
    await pool.query(`INSERT INTO body_metrics (id, client_id, date, weight_kg, created_at)
      VALUES ($1 || '-metric', $1, '2026-01-06', 70.5, '2026-01-06 10:00:00')`, [id]);
  }
}

async function digest(pool, sql) {
  return (await pool.query(`SELECT count(*)::int AS rows,
    md5(coalesce(string_agg(image, '|' ORDER BY image), '')) AS hash FROM (${sql}) t`)).rows[0];
}

async function state(pool) {
  return {
    users: await digest(pool, 'SELECT to_jsonb(u)::text AS image FROM users u'),
    profiles: await digest(pool, `SELECT (to_jsonb(p) - 'onboarding_completed_at'
      - 'onboarding_outcome')::text AS image FROM profiles p`),
    dayProgress: await digest(pool, 'SELECT to_jsonb(d)::text AS image FROM day_progress d'),
    bodyMetrics: await digest(pool, 'SELECT to_jsonb(b)::text AS image FROM body_metrics b'),
  };
}

async function fullState(pool) {
  return {
    ...(await state(pool)),
    marks: (await pool.query(`SELECT user_id, onboarding_completed_at, onboarding_outcome
      FROM profiles ORDER BY user_id`)).rows,
  };
}

async function marks(pool) {
  const rows = (await pool.query(`SELECT user_id, onboarding_completed_at, onboarding_outcome
    FROM profiles WHERE user_id = ANY($1)`, [Object.values(F)])).rows;
  return Object.fromEntries(rows.map((row) => [row.user_id, row]));
}

async function upgradeChecks(url, report) {
  const pool = new Pool({ connectionString: url });
  let before;
  try {
    report.legacyMigrations = await applyLegacyMigrations(pool);
    await legacyFixtures(pool);
    before = await state(pool);
  } finally { await pool.end(); }
  prisma(['migrate', 'deploy'], url);
  prisma(['migrate', 'status'], url);
  const upgraded = new Pool({ connectionString: url });
  try {
    const applied = (await upgraded.query(`SELECT migration_name FROM _prisma_migrations
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name DESC LIMIT 1`)).rows;
    assert.deepEqual(applied, [{ migration_name: TARGET }]);
    // OP-MIG-02: every row preserved, new columns NULL everywhere, no data written.
    assert.deepEqual(await state(upgraded), before, 'existing rows changed by the migration');
    const unmarked = (await upgraded.query(`SELECT count(*)::int AS total,
        count(*) FILTER (WHERE onboarding_completed_at IS NULL AND onboarding_outcome IS NULL)::int AS empty
      FROM profiles`)).rows[0];
    assert.equal(unmarked.total, 8);
    assert.equal(unmarked.empty, unmarked.total);
    report.checks.push('OP-MIG-02 upgrade: users/profiles/day_progress/body_metrics hashes unchanged, 8/8 profiles NULL, status clean');

    // F9: marked by the endpoint's first-write-wins UPDATE before the backfill.
    // UTC wall-clock text, as Prisma writes DateTime into TIMESTAMP(3).
    const f9Date = '2026-11-20 08:30:00';
    const marked = await upgraded.query(`UPDATE profiles SET onboarding_completed_at = $2::timestamp,
        onboarding_outcome = 'SKIPPED', updated_at = now()
      WHERE user_id = $1 AND onboarding_completed_at IS NULL`, [F.f9, f9Date]);
    assert.equal(marked.rowCount, 1);

    // The backfill must store UTC instants like Prisma does, whatever the
    // session TimeZone of the target; a non-UTC default proves it.
    await upgraded.query(`ALTER DATABASE "${new URL(url).pathname.slice(1)}" SET timezone = 'Europe/Madrid'`);

    // OP-MIG-03: dry-run reports exactly F1, F2, F3, F7 and writes nothing.
    const beforeDry = await fullState(upgraded);
    const dry = backfill([], url);
    assert.deepEqual(dry, { mode: 'dry-run', eligible: 4,
      by_signal: { fcm_token: 2, day_progress: 2, body_metrics: 2 } });
    assert.deepEqual(await fullState(upgraded), beforeDry, 'dry-run wrote data');
    const explicitDry = backfill(['--dry-run'], url);
    assert.deepEqual(explicitDry, dry);
    report.dryRun = dry;
    report.checks.push('OP-MIG-03 dry-run: eligible 4 (F1,F2,F3,F7), by signal fcm 2 / day_progress 2 / body_metrics 2, state unchanged');

    // OP-MIG-04/05: --apply marks exactly F1, F2, F3, F7 with one timestamp and NULL outcome.
    const beforeApply = await state(upgraded);
    const applyResult = backfill(['--apply'], url);
    assert.deepEqual(applyResult, { mode: 'apply', eligible: 4,
      by_signal: { fcm_token: 2, day_progress: 2, body_metrics: 2 }, affected: 4 });
    const after = await marks(upgraded);
    const stamps = new Set([F.f1, F.f2, F.f3, F.f7].map((id) => {
      assert.ok(after[id].onboarding_completed_at instanceof Date, `${id} must be marked`);
      assert.equal(after[id].onboarding_outcome, null);
      return after[id].onboarding_completed_at.getTime();
    }));
    assert.equal(stamps.size, 1, 'one backfill timestamp');
    const utc = (await upgraded.query(`SELECT bool_and(abs(extract(epoch FROM
        ((now() AT TIME ZONE 'UTC') - onboarding_completed_at))) < 300) AS ok
      FROM profiles WHERE user_id = ANY($1)`, [[F.f1, F.f2, F.f3, F.f7]])).rows[0];
    assert.equal(utc.ok, true, 'backfill timestamps must be UTC instants');
    for (const id of [F.f4, F.f5, F.f6]) {
      assert.deepEqual([after[id].onboarding_completed_at, after[id].onboarding_outcome], [null, null]);
    }
    const f9 = (await upgraded.query(`SELECT onboarding_completed_at::text AS stamp, onboarding_outcome
      FROM profiles WHERE user_id = $1`, [F.f9])).rows[0];
    assert.deepEqual(f9, { stamp: f9Date, onboarding_outcome: 'SKIPPED' });
    assert.equal(after[F.f8], undefined, 'F8 has no profile and gets none');
    assert.deepEqual(await state(upgraded), beforeApply, 'backfill changed other columns or tables');
    report.apply = applyResult;
    report.checks.push('OP-MIG-04 apply: affected 4 = F1,F2,F3,F7 one UTC timestamp (session TimeZone Europe/Madrid), outcome NULL; F4,F5,F6 NULL; F9 kept SKIPPED+date; F8 untouched');
    report.checks.push('OP-MIG-05 apply: hashes of profiles (minus new columns, incl. updated_at), users, day_progress, body_metrics unchanged');

    // OP-MIG-06: idempotent re-run.
    const beforeRerun = await fullState(upgraded);
    const rerun = backfill(['--apply'], url);
    assert.deepEqual(rerun, { mode: 'apply', eligible: 0,
      by_signal: { fcm_token: 0, day_progress: 0, body_metrics: 0 }, affected: 0 });
    assert.deepEqual(await fullState(upgraded), beforeRerun);
    report.rerun = rerun;
    report.checks.push('OP-MIG-06 second apply: affected 0, state unchanged');
  } finally { await upgraded.end(); }
}

async function restoreChecks(url, report) {
  // OP-MIG-08: the documented withdrawal SQL, then a clean re-application.
  prisma(['migrate', 'deploy'], url);
  const pool = new Pool({ connectionString: url });
  try {
    await pool.query(`INSERT INTO users (id, email, firebase_uid, role, updated_at)
      VALUES ('restore-client', 'restore-client@example.test', 'restore-client', 'CLIENT', now())`);
    await pool.query(`INSERT INTO profiles (id, user_id, first_name, last_name, updated_at,
        onboarding_completed_at, onboarding_outcome)
      VALUES ('restore-profile', 'restore-client', 'Rosa', 'Restore', now(), now(), 'COMPLETED')`);
    const before = await state(pool);
    await pool.query(fs.readFileSync(ROLLBACK, 'utf8'));
    assert.deepEqual(await profileColumns(pool), [], 'columns must be dropped');
    const type = (await pool.query(`SELECT count(*)::int AS n FROM pg_type WHERE typname = 'OnboardingOutcome'`)).rows[0];
    assert.equal(type.n, 0, 'enum type must be dropped');
    const record = (await pool.query(`SELECT count(*)::int AS n FROM _prisma_migrations
      WHERE migration_name = $1`, [TARGET])).rows[0];
    assert.equal(record.n, 0, 'migration record must be withdrawn');
    assert.deepEqual(await state(pool), before, 'withdrawal must keep every other column and row');
  } finally { await pool.end(); }
  prisma(['migrate', 'deploy'], url);
  prisma(['migrate', 'status'], url);
  const reapplied = new Pool({ connectionString: url });
  try {
    const row = (await reapplied.query(`SELECT onboarding_completed_at, onboarding_outcome
      FROM profiles WHERE user_id = 'restore-client'`)).rows[0];
    assert.deepEqual(row, { onboarding_completed_at: null, onboarding_outcome: null });
  } finally { await reapplied.end(); }
  report.checks.push('OP-MIG-08 restore: rollback.sql drops 2 columns + type + migration record, keeps rows; migrate deploy re-applies cleanly (marks lost, as documented)');
}

async function freshChecks(url, report) {
  // OP-MIG-01: all migrations on an empty database match the Prisma datamodel.
  prisma(['migrate', 'deploy'], url);
  prisma(['migrate', 'status'], url);
  // The onboarding objects must match the datamodel exactly. Drift elsewhere
  // (adherence/challenge objects managed by raw SQL migrations) predates this
  // change and is reported, not hidden.
  const drift = datamodelDrift(url);
  const touching = drift.filter((line) => /profiles|OnboardingOutcome|onboarding_/i.test(line));
  assert.deepEqual(touching, [], 'onboarding schema differs from the datamodel');
  report.unrelatedDrift = [...new Set(drift.map((line) =>
    /(?:TABLE|INDEX|ON)\s+"([^"]+)"/.exec(line)?.[1]).filter(Boolean))].sort();
  const pool = new Pool({ connectionString: url });
  try {
    const labels = (await pool.query(`SELECT e.enumlabel FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'OnboardingOutcome'
      ORDER BY e.enumsortorder`)).rows.map((row) => row.enumlabel);
    assert.deepEqual(labels, ['COMPLETED', 'SKIPPED']);
    assert.deepEqual(await profileColumns(pool), [
      { column_name: 'onboarding_completed_at', data_type: 'timestamp without time zone',
        udt_name: 'timestamp', is_nullable: 'YES', column_default: null },
      { column_name: 'onboarding_outcome', data_type: 'USER-DEFINED',
        udt_name: 'OnboardingOutcome', is_nullable: 'YES', column_default: null },
    ]);
  } finally { await pool.end(); }
  report.checks.push('OP-MIG-01 fresh: migrate deploy + status clean, migrate diff vs datamodel has no profiles/OnboardingOutcome statement, enum and nullable columns without default');
}

async function main() {
  assertTargetIsLatest();
  await verifyDatabase();
  const primary = new Pool({ connectionString: databaseUrl() });
  const suffix = crypto.randomBytes(6).toString('hex');
  const names = {
    upgrade: `exom_ci_onboarding_upgrade_${suffix}`,
    fresh: `exom_ci_onboarding_fresh_${suffix}`,
    restore: `exom_ci_onboarding_restore_${suffix}`,
  };
  const created = [];
  const report = { migration: TARGET, checks: [] };
  try {
    for (const name of Object.values(names)) {
      assert.match(name, SCOPE);
      await primary.query(`CREATE DATABASE "${name}"`);
      created.push(name);
    }
    await upgradeChecks(scopedUrl(names.upgrade), report);
    await restoreChecks(scopedUrl(names.restore), report);
    await freshChecks(scopedUrl(names.fresh), report);
    console.log(JSON.stringify({ result: 'PASS', ...report }, null, 2));
  } finally {
    for (const name of created.reverse()) {
      assert.match(name, SCOPE);
      await primary.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    }
    await primary.end();
  }
}

module.exports = { scopedUrl, TARGET };
if (require.main === module) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
