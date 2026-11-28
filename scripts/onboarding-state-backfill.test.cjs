// OP-MIG-09: safety gates of the onboarding state backfill (no database needed).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  parseArgs, run, main, describeFailure, TARGET_ENV, BACKFILL_SQL, DRY_RUN_SQL,
} = require('./onboarding-state-backfill.cjs');

const SECRET = 'S3cr3t-Pa55word';
const URL_WITH_SECRET = `postgresql://operator:${SECRET}@db.example.invalid:6543/postgres?sslmode=require`;

function fakePool({ failOn } = {}) {
  const queries = [];
  let ended = false;
  let released = false;
  const client = {
    async query(sql) {
      queries.push(sql);
      if (failOn && sql.includes(failOn)) {
        const error = new Error(`relation failure while connecting to ${URL_WITH_SECRET}`);
        error.code = '42P01';
        throw error;
      }
      if (sql === DRY_RUN_SQL) return { rows: [{ eligible: 3, fcm_token: 2, day_progress: 1, body_metrics: 1 }] };
      if (sql === BACKFILL_SQL) return { rowCount: 3, rows: [] };
      return { rows: [] };
    },
    release() { released = true; },
  };
  return {
    queries,
    state: () => ({ ended, released }),
    pool: { connect: async () => client, end: async () => { ended = true; } },
  };
}

test('refuses to run without the explicit target variable (no DATABASE_URL fallback)', () => {
  assert.throws(() => parseArgs([], {}), new RegExp(TARGET_ENV));
  assert.throws(() => parseArgs(['--apply'], { DATABASE_URL: URL_WITH_SECRET }), /no DATABASE_URL fallback/);
  assert.throws(() => parseArgs([], { [TARGET_ENV]: 'not a url' }), /not a valid URL/);
  assert.throws(() => parseArgs([], { [TARGET_ENV]: 'mysql://x@127.0.0.1:1/db' }), /PostgreSQL URL/);
});

test('defaults to dry-run and requires --apply to write', () => {
  const env = { [TARGET_ENV]: URL_WITH_SECRET };
  assert.equal(parseArgs([], env).apply, false);
  assert.equal(parseArgs(['--dry-run'], env).apply, false);
  assert.equal(parseArgs(['--apply'], env).apply, true);
  assert.throws(() => parseArgs(['--dry-run', '--apply'], env), /either --dry-run or --apply/);
  for (const typo of ['--aply', 'apply', '--force', '--apply=true']) {
    assert.throws(() => parseArgs([typo], env), /Unknown argument/);
  }
});

test('dry-run only reads inside a READ ONLY transaction and rolls back', async () => {
  const fake = fakePool();
  const result = await run({ apply: false, url: URL_WITH_SECRET }, { createPool: () => fake.pool });
  assert.deepEqual(result, { mode: 'dry-run', eligible: 3, by_signal: { fcm_token: 2, day_progress: 1, body_metrics: 1 } });
  assert.match(fake.queries[0], /READ ONLY/);
  assert.equal(fake.queries.at(-1), 'ROLLBACK');
  assert.ok(!fake.queries.includes(BACKFILL_SQL), 'dry-run must never run the UPDATE');
  assert.ok(fake.queries.every((sql) => !/^\s*(?:--[^\n]*\n\s*)*UPDATE/i.test(sql)));
  assert.deepEqual(fake.state(), { ended: true, released: true });
});

test('--apply runs the UPDATE in one transaction with a lock timeout and commits', async () => {
  const fake = fakePool();
  const result = await run({ apply: true, url: URL_WITH_SECRET }, { createPool: () => fake.pool });
  assert.deepEqual(result, { mode: 'apply', eligible: 3, by_signal: { fcm_token: 2, day_progress: 1, body_metrics: 1 }, affected: 3 });
  assert.equal(fake.queries[0], 'BEGIN');
  assert.match(fake.queries[1], /lock_timeout/);
  assert.ok(fake.queries.indexOf(BACKFILL_SQL) > 1);
  assert.equal(fake.queries.at(-1), 'COMMIT');
  assert.deepEqual(fake.state(), { ended: true, released: true });
});

test('a failing --apply rolls back and the error output exposes no URL or secret', async () => {
  const fake = fakePool({ failOn: 'UPDATE profiles' });
  const logs = [];
  const failures = [];
  const created = [];
  const code = await main(['--apply'], { [TARGET_ENV]: URL_WITH_SECRET }, (line) => logs.push(line),
    (line) => failures.push(line), { createPool: (url) => { created.push(url); return fake.pool; } });
  assert.equal(fake.queries.at(-1), 'ROLLBACK');
  assert.ok(!fake.queries.includes('COMMIT'));
  assert.deepEqual(created, [URL_WITH_SECRET]);
  assert.equal(code, 1);
  assert.deepEqual(logs, []);
  const sqlError = Object.assign(new Error(`password authentication failed for ${URL_WITH_SECRET}`), { code: '28P01' });
  const outputs = [...failures, describeFailure(sqlError), describeFailure(new Error(URL_WITH_SECRET))];
  for (const output of outputs) {
    assert.ok(!output.includes(SECRET) && !output.includes('db.example.invalid') && !output.includes('operator'), output);
  }
  assert.match(describeFailure(sqlError), /SQLSTATE 28P01/);
});

test('the CLI prints only counts or a sanitized failure', () => {
  const script = path.join(__dirname, 'onboarding-state-backfill.cjs');
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };
  const missing = spawnSync(process.execPath, [script], { env, encoding: 'utf8', windowsHide: true });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, new RegExp(TARGET_ENV));
  // An unreachable reserved address fails before any write; nothing secret is echoed.
  const unreachable = spawnSync(process.execPath, [script, '--apply'], {
    env: { ...env, [TARGET_ENV]: `postgresql://operator:${SECRET}@127.0.0.1:9/postgres` },
    encoding: 'utf8', windowsHide: true, timeout: 20000,
  });
  assert.equal(unreachable.status, 1);
  assert.equal(unreachable.stdout, '');
  assert.ok(!unreachable.stderr.includes(SECRET) && !unreachable.stderr.includes('operator') && !unreachable.stderr.includes('127.0.0.1'));
});

test('backfill.sql keeps the approved eligibility predicate and never touches the outcome', () => {
  const sql = fs.readFileSync(path.join(__dirname, 'sql', 'onboarding-state', 'backfill.sql'), 'utf8')
    .replace(/--[^\n]*\n/g, '');
  assert.match(sql, /UPDATE profiles p\s+SET onboarding_completed_at = \(now\(\) AT TIME ZONE 'UTC'\)\s+FROM users u/);
  for (const clause of ["u.role = 'CLIENT'", 'p.onboarding_completed_at IS NULL', 'u.fcm_token IS NOT NULL',
    'EXISTS (SELECT 1 FROM day_progress d WHERE d.client_id = u.id)',
    'EXISTS (SELECT 1 FROM body_metrics b WHERE b.client_id = u.id)']) {
    assert.ok(sql.includes(clause), clause);
    assert.ok(DRY_RUN_SQL.includes(clause), `dry-run predicate: ${clause}`);
  }
  assert.ok(!/onboarding_outcome|updated_at/.test(sql));
});
