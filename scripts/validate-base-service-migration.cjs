// Fresh-install, upgrade and recovery check for 20261114120000_base_service.
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
const TARGET = '20261114120000_base_service';
const SCOPE = /^exom_ci_base_(?:upgrade|fresh|restore)_[a-f0-9]{12}$/;

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
  // Every migration before the target exactly as committed, recorded so that
  // `prisma migrate deploy` performs only the real upgrade step.
  const names = migrationDirs().filter((name) => name < TARGET);
  assert.ok(names.length > 0 && !names.includes(TARGET));
  assert.equal(migrationDirs().at(-1), TARGET, 'target must be the latest migration');
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
  const tables = (await pool.query(`SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename LIKE 'base_%'`)).rows;
  assert.deepEqual(tables, [], 'fixtures must be written on the previous schema');
  await pool.query(`INSERT INTO users (id, email, firebase_uid, role, updated_at)
    VALUES ('base-admin', 'base-admin@example.test', 'base-admin', 'ADMIN', now()),
      ('base-client', 'base-client@example.test', 'base-client', 'CLIENT', now())`);
  await pool.query(`INSERT INTO durable_work (key, kind, payload, owner_id)
    VALUES ('email:legacy', 'EMAIL', '{"kind":"invitation"}', 'base-client'),
      ('schedule:legacy', 'NOTIFICATION_SCHEDULE', '{}', NULL)`);
}

async function state(pool) {
  const rows = async (sql) => (await pool.query(sql)).rows;
  return {
    users: await rows('SELECT to_jsonb(u) AS image FROM users u ORDER BY id'),
    work: await rows('SELECT to_jsonb(w) AS image FROM durable_work w ORDER BY key'),
  };
}

async function rejects(pool, sql, params, code) {
  await assert.rejects(pool.query(sql, params), (error) => error.code === code, sql);
}

async function functionalChecks(pool) {
  const insert = `INSERT INTO base_subscribers (id, name, email, goal, days_per_week, created_by_id, updated_at)
    VALUES ($1, $2, $3, 'perder-grasa', 3, $4, now()) RETURNING order_code`;
  const a = (await pool.query(insert, ['s-a', 'Ana', 'ana@example.test', 'base-admin'])).rows[0];
  const b = (await pool.query(insert, ['s-b', 'Bea', 'bea@example.test', 'base-admin'])).rows[0];
  assert.deepEqual([a.order_code, b.order_code], ['EXB-000001', 'EXB-000002']);
  await pool.query(`SELECT setval('base_subscriber_order_seq', 999999)`);
  const big = (await pool.query(insert, ['s-c', 'Cris', 'cris@example.test', null])).rows[0];
  assert.equal(big.order_code, 'EXB-1000000', 'order codes must never truncate');
  await rejects(pool, insert, ['s-d', 'Dup', 'ana@example.test', null], '23505');
  await pool.query(`UPDATE base_subscribers SET is_archived = true, archived_at = now() WHERE id = 's-a'`);
  await pool.query(insert, ['s-e', 'Ana 2', 'Ana@Example.test'.toLowerCase(), null]);
  await rejects(pool, `UPDATE base_subscribers SET order_code = 'EXB-000009' WHERE id = 's-b'`, [], '23514');
  await rejects(pool, `UPDATE base_subscribers SET is_archived = true WHERE id = 's-b'`, [], '23514');
  await rejects(pool, insert, ['s-f', 'Up', 'UPPER@example.test', null], '23514');
  const delivery = `INSERT INTO base_deliveries (id, subscriber_id, month, snapshot_name, snapshot_email,
      snapshot_goal, snapshot_days_per_week, snapshot_order_code, files, requested_by_id, updated_at)
    VALUES ($1, 's-b', $2, 'Bea', 'bea@example.test', 'perder-grasa', 3, 'EXB-000002',
      '[{"filename":"a.pdf"}]', 'base-admin', now())`;
  await pool.query(delivery, ['d-1', 1]);
  await rejects(pool, delivery, ['d-2', 1], '23505');
  await rejects(pool, delivery, ['d-3', 0], '23514');
  await rejects(pool, `UPDATE base_deliveries SET status = 'SENT' WHERE id = 'd-1'`, [], '23514');
  await pool.query(`UPDATE base_deliveries SET status = 'SENT', sent_at = now(), provider_message_id = 'm'
    WHERE id = 'd-1'`);
  await rejects(pool, `UPDATE base_deliveries SET snapshot_email = 'x@example.test' WHERE id = 'd-1'`, [], '23514');
  await pool.query(`UPDATE base_deliveries SET send_seq = 2, status = 'PENDING' WHERE id = 'd-1'`);
  await rejects(pool, `UPDATE base_deliveries SET send_seq = 1 WHERE id = 'd-1'`, [], '23514');
  // Recipient of a send: changes only together with the next send (resend).
  await pool.query(`UPDATE base_deliveries SET status = 'FAILED', last_error = 'X' WHERE id = 'd-1'`);
  const recipient = `snapshot_name = 'Bea B', snapshot_email = 'bea.b@example.test'`;
  await rejects(pool, `UPDATE base_deliveries SET ${recipient} WHERE id = 'd-1'`, [], '23514');
  await rejects(pool, `UPDATE base_deliveries SET snapshot_email = 'bea.b@example.test',
    send_seq = 3, status = 'FAILED' WHERE id = 'd-1'`, [], '23514');
  await rejects(pool, `UPDATE base_deliveries SET ${recipient}, send_seq = 4, status = 'PENDING',
    last_error = NULL WHERE id = 'd-1'`, [], '23514');
  for (const frozen of [`snapshot_goal = 'ganar-musculo'`, 'snapshot_days_per_week = 4',
    `snapshot_order_code = 'EXB-000009'`, 'month = 2', `files = '[{"filename":"b.pdf"}]'`,
    `requested_at = now() - interval '1 day'`, `subscriber_id = 's-c'`]) {
    await rejects(pool, `UPDATE base_deliveries SET ${frozen}, ${recipient}, send_seq = 3,
      status = 'PENDING', last_error = NULL WHERE id = 'd-1'`, [], '23514');
  }
  await pool.query(`UPDATE base_deliveries SET ${recipient}, send_seq = 3, status = 'PENDING',
    last_error = NULL WHERE id = 'd-1'`);
  await rejects(pool, `UPDATE base_deliveries SET snapshot_name = 'Bea C' WHERE id = 'd-1'`, [], '23514');
  // History survives: subscribers with deliveries cannot be deleted; admins can.
  await rejects(pool, `DELETE FROM base_subscribers WHERE id = 's-b'`, [], '23503');
  await pool.query(`DELETE FROM users WHERE id = 'base-admin'`);
  const kept = (await pool.query(`SELECT
      (SELECT created_by_id FROM base_subscribers WHERE id = 's-b') AS creator,
      (SELECT requested_by_id FROM base_deliveries WHERE id = 'd-1') AS requester,
      (SELECT snapshot_name FROM base_deliveries WHERE id = 'd-1') AS snapshot`)).rows[0];
  assert.deepEqual(kept, { creator: null, requester: null, snapshot: 'Bea B' });
  const rls = (await pool.query(`SELECT relname, relrowsecurity FROM pg_class
    WHERE relname IN ('base_subscribers', 'base_deliveries') ORDER BY relname`)).rows;
  assert.deepEqual(rls, [
    { relname: 'base_deliveries', relrowsecurity: true },
    { relname: 'base_subscribers', relrowsecurity: true },
  ]);
}

async function main() {
  await verifyDatabase();
  const primary = new Pool({ connectionString: databaseUrl() });
  const suffix = crypto.randomBytes(6).toString('hex');
  const names = {
    upgrade: `exom_ci_base_upgrade_${suffix}`,
    fresh: `exom_ci_base_fresh_${suffix}`,
    restore: `exom_ci_base_restore_${suffix}`,
  };
  const created = [];
  const report = { migration: TARGET, checks: [] };
  try {
    for (const name of Object.values(names)) {
      assert.match(name, SCOPE);
      await primary.query(`CREATE DATABASE "${name}"`);
      created.push(name);
    }
    // 1. Upgrade from the previous schema with legacy rows.
    const upgrade = new Pool({ connectionString: scopedUrl(names.upgrade) });
    let before;
    try {
      report.legacyMigrations = await applyLegacyMigrations(upgrade);
      await legacyFixtures(upgrade);
      before = await state(upgrade);
    } finally { await upgrade.end(); }
    prisma(['migrate', 'deploy'], scopedUrl(names.upgrade));
    prisma(['migrate', 'status'], scopedUrl(names.upgrade));
    const upgraded = new Pool({ connectionString: scopedUrl(names.upgrade) });
    try {
      assert.deepEqual(await state(upgraded), before, 'existing rows changed');
      const applied = (await upgraded.query(`SELECT migration_name FROM _prisma_migrations
        WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name DESC LIMIT 1`)).rows;
      assert.deepEqual(applied, [{ migration_name: TARGET }]);
      await functionalChecks(upgraded);
      report.checks.push('upgrade: legacy users/durable_work unchanged, constraints/triggers/RLS work, status clean');
    } finally { await upgraded.end(); }
    // 2. Recovery: dump the upgraded database and restore it elsewhere.
    const dump = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'exom-base-')), 'upgrade.dump');
    try {
      pgTool('pg_dump', ['--format=custom', '--no-owner', '--file', dump, '--dbname', names.upgrade],
        scopedUrl(names.upgrade));
      pgTool('pg_restore', ['--no-owner', '--exit-on-error', '--dbname', names.restore, dump],
        scopedUrl(names.restore));
    } finally { fs.rmSync(path.dirname(dump), { recursive: true, force: true }); }
    const restored = new Pool({ connectionString: scopedUrl(names.restore) });
    try {
      const rows = (await restored.query(`SELECT
          (SELECT count(*)::int FROM base_subscribers) AS subscribers,
          (SELECT count(*)::int FROM base_deliveries) AS deliveries,
          (SELECT last_value::int FROM base_subscriber_order_seq) AS sequence`)).rows[0];
      assert.deepEqual(rows, { subscribers: 4, deliveries: 1, sequence: 1000003 });
      const next = (await restored.query(`INSERT INTO base_subscribers (id, name, email, goal, days_per_week, updated_at)
        VALUES ('s-r', 'Rosa', 'rosa@example.test', 'perder-grasa', 3, now()) RETURNING order_code`)).rows[0];
      assert.equal(next.order_code, 'EXB-1000004', 'restored sequence must continue (rejected inserts leave gaps)');
      await rejects(restored, `UPDATE base_subscribers SET order_code = 'X' WHERE id = 's-r'`, [], '23514');
      report.checks.push('recovery: pg_dump/pg_restore keeps rows, sequence position and triggers');
    } finally { await restored.end(); }
    prisma(['migrate', 'status'], scopedUrl(names.restore));
    // 3. Fresh install.
    prisma(['migrate', 'deploy'], scopedUrl(names.fresh));
    prisma(['migrate', 'status'], scopedUrl(names.fresh));
    const fresh = new Pool({ connectionString: scopedUrl(names.fresh) });
    try {
      const values = (await fresh.query(`SELECT e.enumlabel FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'BaseDeliveryStatus'
        ORDER BY e.enumsortorder`)).rows.map((row) => row.enumlabel);
      assert.deepEqual(values, ['PENDING', 'SENT', 'FAILED']);
      await fresh.query(`INSERT INTO users (id, email, firebase_uid, role, updated_at)
        VALUES ('base-admin', 'base-admin@example.test', 'base-admin', 'ADMIN', now())`);
      await functionalChecks(fresh);
      report.checks.push('fresh install: migrate deploy + status clean, same constraints');
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
