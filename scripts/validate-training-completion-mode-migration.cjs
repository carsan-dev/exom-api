// Upgrade/recovery check for 20261011120000_training_completion_mode.
// Runs only against the verified disposable exom_ci cluster (TEST_DATABASE_URL)
// and only inside databases it creates and drops itself. No ambient DATABASE_URL.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Pool } = require('pg');
const { databaseUrl, verifyDatabase } = require('./test-database.cjs');

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS = path.join(ROOT, 'prisma', 'migrations');
const TARGET = '20261011120000_training_completion_mode';
const SCOPE = /^exom_ci_tcm_(?:upgrade|fresh|restore)_[a-f0-9]{12}$/;

function scopedUrl(name) {
  assert.match(name, SCOPE);
  const url = new URL(databaseUrl());
  url.pathname = `/${name}`;
  return url.toString();
}

function cliEnv(url) {
  const scoped = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP',
    'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'LANG']) {
    if (process.env[key] !== undefined) scoped[key] = process.env[key];
  }
  // prisma.config.ts selects PRISMA_DATABASE_URL first; dotenv never overrides it.
  return { ...scoped, PRISMA_DATABASE_URL: url, DATABASE_URL: url };
}

function prisma(args, url) {
  const config = fs.readFileSync(path.join(ROOT, 'prisma.config.ts'), 'utf8');
  assert.ok(config.includes('process.env["PRISMA_DATABASE_URL"] ?? process.env["DATABASE_URL"]'),
    'Prisma CLI datasource selection changed');
  const cli = path.join(ROOT, 'node_modules', 'prisma', 'build', 'index.js');
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: ROOT, env: cliEnv(url), encoding: 'utf8', windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  // Output can echo connection details: report only the status.
  assert.ok(!result.error && result.status === 0, `prisma ${args.join(' ')} failed`);
}

function pgTool(tool, args, url) {
  const bin = process.env.PG_BIN ? path.join(process.env.PG_BIN, tool) : tool;
  const parsed = new URL(url);
  const result = spawnSync(bin, [
    '--host', parsed.hostname, '--port', parsed.port,
    '--username', decodeURIComponent(parsed.username), ...args,
  ], {
    env: { ...cliEnv(url), PGPASSWORD: decodeURIComponent(parsed.password) },
    encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024,
  });
  assert.ok(!result.error && result.status === 0, `${tool} failed`);
}

function migrationDirs() {
  return fs.readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

async function applyLegacyMigrations(pool) {
  // Apply every migration before the target exactly as committed, then record
  // them so `prisma migrate deploy` performs only the real upgrade step.
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

async function legacyFixtures(pool) {
  const columns = (await pool.query(`SELECT table_name, column_name FROM information_schema.columns
    WHERE column_name = 'training_completion_mode'`)).rows;
  assert.deepEqual(columns, [], 'fixtures must be written on the previous schema');
  const id = (label) => `tcm-${label}`;
  await pool.query(`INSERT INTO users (id, email, firebase_uid, role, updated_at)
    VALUES ($1, $2, $1, 'CLIENT', now()), ($3, $4, $3, 'ADMIN', now())`,
  [id('client'), 'tcm-client@example.test', id('admin'), 'tcm-admin@example.test']);
  for (const n of [1, 2, 3]) {
    await pool.query(`INSERT INTO exercises (id, name, muscle_groups, equipment, updated_at)
      VALUES ($1, $1, '{}', '{}', now())`, [id(`exercise-${n}`)]);
    await pool.query(`INSERT INTO trainings (id, name, type, updated_at)
      VALUES ($1, $1, 'TEST', now())`, [id(`training-${n}`)]);
    await pool.query(`INSERT INTO training_exercises (id, training_id, exercise_id, "order", sets, reps_or_duration)
      VALUES ($1, $2, $3, 0, 1, '10')`, [id(`occurrence-${n}`), id(`training-${n}`), id(`exercise-${n}`)]);
  }
  await pool.query(`INSERT INTO auto_assignment_rules
      (id, client_id, admin_id, source_week_start, starts_on, ends_on, is_active, deactivated_at, updated_at)
    VALUES ($1, $3, $4, '2025-12-29', '2025-12-29', NULL, true, NULL, now()),
      ($2, $3, $4, '2025-11-03', '2025-11-03', '2025-12-28', false, now(), now())`,
  [id('rule-active'), id('rule-inactive'), id('client'), id('admin')]);
  const assignments = [
    // [label, date, rule, trainings]
    ['single', '2025-12-01', null, [1]],
    ['three', '2025-12-02', null, [1, 2, 3]],
    ['inactive-rule', '2025-11-10', 'rule-inactive', [1, 2]],
    ['rule-past', '2026-01-05', 'rule-active', [1, 2, 3]],
    ['rule-future', '2099-01-05', 'rule-active', [1, 2]],
    ['manual', '2026-01-06', null, [2]],
  ];
  for (const [label, date, rule, trainings] of assignments) {
    await pool.query(`INSERT INTO plan_assignments
        (id, client_id, admin_id, date, training_id, auto_assignment_rule_id, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, now())`,
    [id(`assignment-${label}`), id('client'), id('admin'), date,
      id(`training-${trainings[0]}`), rule ? id(rule) : null]);
    for (const [position, n] of trainings.entries()) {
      await pool.query(`INSERT INTO plan_assignment_trainings (id, assignment_id, training_id, position)
        VALUES ($1, $2, $3, $4)`, [id(`link-${label}-${n}`), id(`assignment-${label}`), id(`training-${n}`), position]);
    }
  }
  // Legacy single-training day: flag true, no stored IDs. Three-training day: 1 of 3.
  await pool.query(`INSERT INTO day_progress (id, client_id, date, training_completed,
      trainings_completed, exercises_completed, meals_completed, updated_at)
    VALUES ($1, $3, '2025-12-01', true, '{}', '[]', '{}', now()),
      ($2, $3, '2025-12-02', false, $4, $5, '{}', now())`,
  [id('progress-single'), id('progress-three'), id('client'), [id('training-2')],
    JSON.stringify([{ exercise_id: id('exercise-2'), training_exercise_id: id('occurrence-2'),
      completed_at: '2025-12-02T10:00:00.000Z' }])]);
}

async function state(pool) {
  const rows = async (sql) => (await pool.query(sql)).rows;
  return {
    assignments: await rows(`SELECT id, to_jsonb(p) - 'training_completion_mode' AS image,
      to_jsonb(p)->>'training_completion_mode' AS mode FROM plan_assignments p ORDER BY id`),
    rules: await rows(`SELECT id, to_jsonb(r) - 'training_completion_mode' AS image,
      to_jsonb(r)->>'training_completion_mode' AS mode FROM auto_assignment_rules r ORDER BY id`),
    progress: await rows('SELECT id, to_jsonb(d) AS image FROM day_progress d ORDER BY id'),
    links: await rows('SELECT id, to_jsonb(l) AS image FROM plan_assignment_trainings l ORDER BY id'),
    journal: await rows('SELECT count(*)::int AS n FROM adherence_assignment_journal'),
    baselines: await rows('SELECT count(*)::int AS n FROM adherence_history_baselines'),
    work: await rows('SELECT count(*)::int AS n FROM durable_work'),
  };
}

async function main() {
  await verifyDatabase();
  const primary = new Pool({ connectionString: databaseUrl() });
  const suffix = crypto.randomBytes(6).toString('hex');
  const names = { upgrade: `exom_ci_tcm_upgrade_${suffix}`, fresh: `exom_ci_tcm_fresh_${suffix}`,
    restore: `exom_ci_tcm_restore_${suffix}` };
  const created = [];
  const report = { migration: TARGET, checks: [] };
  try {
    for (const name of Object.values(names)) {
      assert.match(name, SCOPE);
      await primary.query(`CREATE DATABASE "${name}"`);
      created.push(name);
    }
    // 1. Upgrade from the previous schema with legacy fixtures.
    const upgrade = new Pool({ connectionString: scopedUrl(names.upgrade) });
    let before;
    try {
      report.legacyMigrations = await applyLegacyMigrations(upgrade);
      await legacyFixtures(upgrade);
      const epoch = (await upgrade.query('SELECT * FROM public.activate_adherence_history_origin()')).rows;
      assert.equal(epoch.length, 1, 'adherence baseline epoch not captured');
      before = await state(upgrade);
      assert.ok(before.baselines[0].n > 0, 'baseline row images missing');
      assert.ok(before.assignments.every((row) => row.mode === null));
    } finally { await upgrade.end(); }
    prisma(['migrate', 'deploy'], scopedUrl(names.upgrade));
    prisma(['migrate', 'status'], scopedUrl(names.upgrade));
    const upgraded = new Pool({ connectionString: scopedUrl(names.upgrade) });
    try {
      const after = await state(upgraded);
      assert.ok(after.assignments.length === 6 && after.assignments.every((row) => row.mode === 'ALL'));
      assert.ok(after.rules.length === 2 && after.rules.every((row) => row.mode === 'ALL'));
      assert.deepEqual(after.assignments.map((row) => row.image), before.assignments.map((row) => row.image));
      assert.deepEqual(after.rules.map((row) => row.image), before.rules.map((row) => row.image));
      assert.deepEqual(after.progress, before.progress, 'day_progress rows changed');
      assert.deepEqual(after.links, before.links, 'plan_assignment_trainings changed');
      assert.deepEqual(after.journal, before.journal, 'ADD COLUMN wrote journal events');
      assert.deepEqual(after.baselines, before.baselines, 'baseline images changed');
      assert.deepEqual(after.work, before.work, 'ADD COLUMN enqueued durable work');
      const applied = (await upgraded.query(`SELECT migration_name FROM _prisma_migrations
        WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name DESC LIMIT 1`)).rows;
      assert.deepEqual(applied, [{ migration_name: TARGET }]);
      // Old row images lack the key; new events carry it.
      await upgraded.query(`UPDATE plan_assignments SET training_completion_mode = 'ANY'
        WHERE id = 'tcm-assignment-three'`);
      const event = (await upgraded.query(`SELECT new_row->>'training_completion_mode' AS mode
        FROM adherence_assignment_journal ORDER BY event_sequence DESC LIMIT 1`)).rows;
      assert.deepEqual(event, [{ mode: 'ANY' }]);
      const legacyImage = (await upgraded.query(`SELECT count(*)::int AS n FROM adherence_history_baselines
        WHERE source_table = 'plan_assignments' AND row_image ? 'training_completion_mode'`)).rows;
      assert.deepEqual(legacyImage, [{ n: 0 }]);
      await upgraded.query(`UPDATE plan_assignments SET training_completion_mode = 'ALL'
        WHERE id = 'tcm-assignment-three'`);
      report.checks.push('upgrade: legacy rows read ALL, no data rewritten, status clean');
    } finally { await upgraded.end(); }
    // 2. Recovery: dump the upgraded database and restore it elsewhere.
    const dump = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'exom-tcm-')), 'upgrade.dump');
    try {
      pgTool('pg_dump', ['--format=custom', '--no-owner', '--file', dump, '--dbname', names.upgrade],
        scopedUrl(names.upgrade));
      pgTool('pg_restore', ['--no-owner', '--exit-on-error', '--dbname', names.restore, dump],
        scopedUrl(names.restore));
    } finally { fs.rmSync(path.dirname(dump), { recursive: true, force: true }); }
    const restored = new Pool({ connectionString: scopedUrl(names.restore) });
    try {
      const copy = await state(restored);
      assert.ok(copy.assignments.length === 6 && copy.assignments.every((row) => row.mode === 'ALL'));
      assert.deepEqual(copy.progress, before.progress);
      const defaults = (await restored.query(`SELECT table_name, column_default, is_nullable
        FROM information_schema.columns WHERE column_name = 'training_completion_mode' ORDER BY table_name`)).rows;
      assert.deepEqual(defaults, [
        { table_name: 'auto_assignment_rules', column_default: `'ALL'::"TrainingCompletionMode"`, is_nullable: 'NO' },
        { table_name: 'plan_assignments', column_default: `'ALL'::"TrainingCompletionMode"`, is_nullable: 'NO' },
      ]);
      report.checks.push('recovery: pg_dump/pg_restore keeps modes, defaults and progress');
    } finally { await restored.end(); }
    prisma(['migrate', 'status'], scopedUrl(names.restore));
    // 3. Fresh install.
    prisma(['migrate', 'deploy'], scopedUrl(names.fresh));
    prisma(['migrate', 'status'], scopedUrl(names.fresh));
    const fresh = new Pool({ connectionString: scopedUrl(names.fresh) });
    try {
      const values = (await fresh.query(`SELECT e.enumlabel FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'TrainingCompletionMode'
        ORDER BY e.enumsortorder`)).rows.map((row) => row.enumlabel);
      assert.deepEqual(values, ['ALL', 'ANY']);
      report.checks.push('fresh install: migrate deploy + status clean');
    } finally { await fresh.end(); }
    console.log(JSON.stringify({ result: 'PASS', ...report }));
  } finally {
    for (const name of created.reverse()) {
      assert.match(name, SCOPE);
      await primary.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    }
    await primary.end();
  }
}

module.exports = { scopedUrl };
if (require.main === module) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
