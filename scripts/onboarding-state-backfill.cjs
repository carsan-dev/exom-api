// Onboarding state backfill (plan onboarding-persistente, OP-D4/OP-D12).
//
//   ONBOARDING_BACKFILL_DATABASE_URL=<target> node scripts/onboarding-state-backfill.cjs [--dry-run | --apply]
//
// Dry-run is the default: counts eligible profiles by signal inside a READ ONLY
// transaction and writes nothing. --apply runs scripts/sql/onboarding-state/backfill.sql
// in one transaction and reports the affected rows. The target comes only from
// ONBOARDING_BACKFILL_DATABASE_URL (never DATABASE_URL or dotenv). Output holds
// counts only: no URLs, credentials, identifiers or personal data.
// Running --apply against a real environment requires explicit authorization
// covering action, environment and population (docs/onboarding-state-backfill.md).
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const TARGET_ENV = 'ONBOARDING_BACKFILL_DATABASE_URL';
const BACKFILL_SQL = fs.readFileSync(
  path.join(__dirname, 'sql', 'onboarding-state', 'backfill.sql'), 'utf8');
// Same eligibility predicate as backfill.sql, split by signal.
const DRY_RUN_SQL = `
SELECT count(*)::int AS eligible,
       count(*) FILTER (WHERE u.fcm_token IS NOT NULL)::int AS fcm_token,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM day_progress d WHERE d.client_id = u.id))::int AS day_progress,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM body_metrics b WHERE b.client_id = u.id))::int AS body_metrics
  FROM profiles p
  JOIN users u ON u.id = p.user_id
 WHERE u.role = 'CLIENT'
   AND p.onboarding_completed_at IS NULL
   AND (u.fcm_token IS NOT NULL
        OR EXISTS (SELECT 1 FROM day_progress d WHERE d.client_id = u.id)
        OR EXISTS (SELECT 1 FROM body_metrics b WHERE b.client_id = u.id))`;
// A busy row makes --apply fail fast instead of queueing behind live traffic;
// the run is idempotent and can simply be repeated.
const LOCK_TIMEOUT = "SET LOCAL lock_timeout = '5s'";

class BackfillUsageError extends Error {}

function parseArgs(argv, env) {
  const known = new Set(['--dry-run', '--apply']);
  for (const arg of argv) {
    if (!known.has(arg)) throw new BackfillUsageError(`Unknown argument; use --dry-run (default) or --apply`);
  }
  if (argv.includes('--dry-run') && argv.includes('--apply')) {
    throw new BackfillUsageError('Choose either --dry-run or --apply');
  }
  const url = env[TARGET_ENV];
  if (!url) throw new BackfillUsageError(`${TARGET_ENV} is required; there is no DATABASE_URL fallback`);
  let parsed;
  try { parsed = new URL(url); } catch { throw new BackfillUsageError(`${TARGET_ENV} is not a valid URL`); }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new BackfillUsageError(`${TARGET_ENV} must be a PostgreSQL URL`);
  }
  return { apply: argv.includes('--apply'), url };
}

function counts(row) {
  return {
    eligible: row.eligible,
    by_signal: { fcm_token: row.fcm_token, day_progress: row.day_progress, body_metrics: row.body_metrics },
  };
}

async function run({ apply, url }, { createPool = (connectionString) => new Pool({ connectionString }) } = {}) {
  const pool = createPool(url);
  try {
    const client = await pool.connect();
    try {
      if (!apply) {
        await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        try {
          const { rows } = await client.query(DRY_RUN_SQL);
          return { mode: 'dry-run', ...counts(rows[0]) };
        } finally { await client.query('ROLLBACK'); }
      }
      await client.query('BEGIN');
      try {
        await client.query(LOCK_TIMEOUT);
        const { rows } = await client.query(DRY_RUN_SQL);
        const result = await client.query(BACKFILL_SQL);
        await client.query('COMMIT');
        return { mode: 'apply', ...counts(rows[0]), affected: result.rowCount };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    } finally { client.release(); }
  } finally { await pool.end(); }
}

// Driver and PostgreSQL messages can echo hosts, roles or values: report only
// our own usage messages or a SQLSTATE / error class.
function describeFailure(error) {
  if (error instanceof BackfillUsageError) return error.message;
  const code = error && typeof error.code === 'string' && /^[A-Z0-9]{5}$/.test(error.code) ? error.code : null;
  return code ? `Backfill failed (SQLSTATE ${code}); nothing was committed unless --apply reported success`
    : 'Backfill failed before completion; nothing was committed unless --apply reported success';
}

async function main(argv = process.argv.slice(2), env = process.env, log = console.log, fail = console.error, deps = {}) {
  try {
    const options = parseArgs(argv, env);
    const result = await run(options, deps);
    log(JSON.stringify(result));
    return 0;
  } catch (error) {
    fail(describeFailure(error));
    return 1;
  }
}

module.exports = { parseArgs, run, main, describeFailure, BackfillUsageError, TARGET_ENV, BACKFILL_SQL, DRY_RUN_SQL };
if (require.main === module) {
  main().then((code) => { process.exitCode = code; });
}
