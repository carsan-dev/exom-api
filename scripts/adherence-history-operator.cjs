'use strict';
// Manual privileged caller. No application boot, grants, reconnect or scheduler.
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function reject() { throw new Error('invalid_configuration'); }
function cutoff(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) reject();
  const ms = Date.parse(date + 'T00:00:00.000Z');
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== date) reject();
  return new Date(ms + 86400000).toISOString().replace('.000Z', '.000000Z');
}
function validate(options, connectionString) {
  if (!['preflight', 'run', 'resume'].includes(options.command)) reject();
  if (!connectionString || !options.host || !options.database || !options.role) reject();
  const url = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== options.host || decodeURIComponent(url.username) !== options.role || decodeURIComponent(url.pathname.slice(1)) !== options.database || url.hash) reject();
  for (const [key, value] of url.searchParams) if (key !== 'sslmode' || value !== 'verify-full') reject();
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.searchParams.get('sslmode') !== 'verify-full') reject();
  if (!Array.isArray(options.clients) || options.clients.length < 1 || options.clients.length > 100 || options.clients.some((id) => typeof id !== 'string' || !UUID.test(id)) || new Set(options.clients.map((id) => id.toLowerCase())).size !== options.clients.length) reject();
  for (const [key, min, max] of [['maxWaitSeconds', 1, 300], ['maxTransactions', 1, 128], ['maxStatements', 7, 4096]]) if (!Number.isInteger(options[key]) || options[key] < min || options[key] > max) reject();
  if (options.command !== 'preflight' && options.trust !== true) reject();
  if (options.command === 'resume' && (!UUID.test(options.epochId || '') || !UUID.test(options.origin || ''))) reject();
  return { ...options, cutoffUtc: cutoff(options.date) };
}
function aborted(signal) { if (signal?.aborted) throw new Error('cancelled'); }
async function operate(options, deps, signal) {
  let lease; let stored = 0; let unknown = 0;
  const binding = { epochId: options.epochId, origin: options.origin, cutoffUtc: cutoff(options.date) };
  try {
    aborted(signal);
    await deps.preflight();
    aborted(signal);
    if (options.command === 'preflight') return { status: 'ready', reasonCode: 'readonly_preflight', stored, unknown };
    if (options.command === 'run') {
      const target = Date.parse(binding.cutoffUtc);
      const now = await deps.now();
      if (now >= target || target - now > options.maxWaitSeconds * 1000) throw new Error('outside_activation_window');
      aborted(signal);
      const client = await deps.acquire();
      // Ownership transfers here, including failure cleanup. Never touch client again.
      lease = await deps.activate(client);
      binding.epochId = lease.epochId; binding.origin = lease.origin;
      const deadline = performance.now() + options.maxWaitSeconds * 1000;
      while (true) {
        aborted(signal);
        const now = await deps.clock(lease);
        if (performance.now() > deadline) throw new Error('wait_budget');
        if (now >= target) break;
        await deps.sleep(Math.min(250, target - now), signal);
      }
      aborted(signal);
      if ((await deps.cut(lease, { cutoffUtc: binding.cutoffUtc, trustedPgUtcClockAndOwner: true, maxTransactions: options.maxTransactions, maxStatements: options.maxStatements })).status !== 'cut') throw new Error('unproven_cut');
    } else if ((await deps.validateCut(binding)).status !== 'cut') throw new Error('unproven_original_cut');
    for (const client of options.clients) {
      aborted(signal);
      try { if ((await deps.publish(client, options.date, binding)).status === 'stored') stored++; else unknown++; }
      catch { unknown = options.clients.length - stored; break; }
    }
    return { status: unknown ? (stored ? 'partial' : 'unknown') : 'stored', reasonCode: unknown ? 'publication_unknown' : 'acknowledged', stored, unknown };
  } catch {
    return { status: stored ? 'partial' : 'unknown', reasonCode: signal?.aborted ? 'cancelled' : 'operation_unknown', stored, unknown: options.clients.length - stored };
  } finally {
    try { if (lease) await lease.close(); } finally { await deps.end(); }
  }
}
function rawSql(client, Prisma) {
  class RawPromise extends Promise { get [Symbol.toStringTag]() { return 'PrismaPromise'; } }
  return { $queryRaw(query, ...values) {
    const statement = 'raw' in query ? Prisma.sql(query, ...values) : query;
    return new RawPromise((resolve, reject) => { void client.query(statement.text, statement.values).then((r) => resolve(r.rows), reject); });
  } };
}
function publisher(pool, Prisma) {
  return { async withTransaction(work) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      const result = await work(rawSql(client, Prisma));
      await client.query('COMMIT');
      return result;
    } catch (error) { try { await client.query('ROLLBACK'); } catch { /* Unknown ACK remains unknown. */ } throw error; }
    finally { client.release(); }
  } };
}
async function preflight(pool, options) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const { rows } = await client.query("SELECT current_database() AS db, current_user AS role, current_setting('track_commit_timestamp') AS tracking");
    if (rows[0]?.db !== options.database || rows[0]?.role !== options.role || rows[0]?.tracking !== 'on') reject();
    // Guard functions inspect ownership/source schema without activation or grants.
    await client.query('SELECT public.assert_adherence_commit_owner(), public.assert_adherence_prescription_owner()');
    const sources = ['catalog_colors', 'diet_groups', 'diets', 'exercises', 'ingredients', 'meal_ingredients', 'meals', 'plan_assignment_trainings', 'plan_assignments', 'training_blocks', 'training_exercises', 'training_groups', 'trainings'].map((name) => 'public.' + name);
    for (const name of sources) {
      const result = await client.query('SELECT c.relowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user) AND NOT c.relforcerowsecurity AS ok FROM pg_catalog.pg_class c WHERE c.oid = to_regclass($1)', [name]);
      if (result.rows.length !== 1 || result.rows[0].ok !== true) reject();
    }
    const sequence = await client.query("SELECT c.relowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user) AS ok FROM pg_catalog.pg_class c WHERE c.oid = pg_get_serial_sequence('public.adherence_assignment_journal', 'event_sequence')::regclass");
    if (sequence.rows.length !== 1 || sequence.rows[0].ok !== true) reject();
    for (const name of ['public.capture_adherence_assignment_event()', 'public.capture_adherence_catalog_event()']) {
      const result = await client.query('SELECT p.proowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user) AS ok FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure($1)', [name]);
      if (result.rows.length !== 1 || result.rows[0].ok !== true) reject();
    }
    const objects = ['public.adherence_evaluation_revisions', 'public.adherence_historical_prescriptions'];
    for (const name of objects) {
      const result = await client.query('SELECT to_regclass($1) IS NOT NULL AS ok', [name]);
      if (result.rows[0]?.ok !== true) reject();
    }
    const functions = ['public.activate_adherence_history_origin()', 'public.begin_adherence_history_cut(text,text,integer)', 'public.issue_adherence_history_cut(text,text,text,bigint)', 'public.read_adherence_history_cut(text,text,text)', 'public.adherence_prescription_source(text,text,text)', 'public.publish_adherence_prescription(text,date,text,text,text,jsonb,text)'];
    for (const name of functions) {
      const result = await client.query('SELECT has_function_privilege(current_user, to_regprocedure($1), $2) AS ok', [name, 'EXECUTE']);
      if (result.rows[0]?.ok !== true) reject();
    }
    await client.query('COMMIT');
  } catch (error) { try { await client.query('ROLLBACK'); } catch { /* Never print database diagnostics. */ } throw error; }
  finally { client.release(); }
}
function runtime(pool, options, sdkRoot = path.resolve(__dirname, '../dist/src/modules/adherence')) {
  const { Prisma } = require('@prisma/client');
  require('reflect-metadata');
  const { activateAdherenceHistoryOrigin } = require(path.join(sdkRoot, 'adherence-history-origin.js'));
  const { materializeAdherenceHistoryCut, validateStoredAdherenceHistoryCut } = require(path.join(sdkRoot, 'adherence-history-cut.js'));
  const { AdherencePrescriptionService } = require(path.join(sdkRoot, 'adherence-prescription.service.js'));
  const sql = rawSql(pool, Prisma);
  const service = new AdherencePrescriptionService(sql, publisher(pool, Prisma));
  return {
    preflight: () => preflight(pool, options),
    now: async () => Number((await pool.query('SELECT extract(epoch FROM clock_timestamp()) * 1000 AS ms')).rows[0].ms),
    async acquire() {
      const client = await pool.connect();
      try {
        const r = await client.query('SELECT pg_try_advisory_lock($1, $2) AS ok', [60309, 31]);
        if (r.rows[0]?.ok !== true) throw new Error('operator_busy');
        return client;
      } catch (error) { client.release(true); throw error; }
    },
    activate: activateAdherenceHistoryOrigin,
    clock: (lease) => lease.withSession(async ({ sql }) => Number((await sql.$queryRaw`SELECT extract(epoch FROM clock_timestamp()) * 1000 AS ms`)[0].ms)),
    sleep: (ms, signal) => delay(ms, undefined, { signal }),
    cut: materializeAdherenceHistoryCut,
    validateCut: (binding) => validateStoredAdherenceHistoryCut(sql, binding),
    publish: (client, date, binding) => service.publish(client, date, binding),
    end: () => pool.end(),
  };
}
function parse(args) {
  const options = { command: args.shift(), maxWaitSeconds: 90, maxTransactions: 128, maxStatements: 4096 };
  const names = { '--date': 'date', '--clients-file': 'clientsFile', '--expected-host': 'host', '--expected-database': 'database', '--expected-role': 'role', '--max-wait-seconds': 'maxWaitSeconds', '--max-transactions': 'maxTransactions', '--max-statements': 'maxStatements', '--epoch': 'epochId', '--origin': 'origin' };
  while (args.length) {
    const flag = args.shift();
    if (flag === '--trust-pg-clock-owner-no-maintenance') { if (options.trust) reject(); options.trust = true; continue; }
    const key = names[flag]; if (!key || !args.length || (Object.hasOwn(options, key) && !key.startsWith('max'))) reject();
    options[key] = key.startsWith('max') ? Number(args.shift()) : args.shift();
  }
  const buffer = readFileSync(options.clientsFile);
  if (buffer.length > 8192) reject();
  options.clients = JSON.parse(buffer.toString('utf8'));
  return options;
}
async function main() {
  if (process.argv.length === 2 || process.argv.includes('--help')) {
    console.log('Manual adherence owner: preflight|run|resume --date YYYY-MM-DD --clients-file FILE --expected-host HOST --expected-database DB --expected-role ROLE. Writes require --trust-pg-clock-owner-no-maintenance. Resume requires original --epoch UUID --origin UUID. See docs/adherence-history-operations.md.'); return;
  }
  let pool;
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.on('SIGINT', abort); process.on('SIGTERM', abort);
  try {
    const options = validate(parse(process.argv.slice(2)), process.env.ADHERENCE_OWNER_DATABASE_URL);
    const { Pool } = require('pg');
    const url = new URL(process.env.ADHERENCE_OWNER_DATABASE_URL);
    // Explicit fields prevent pg's PG* environment defaults from supplying a target.
    if (!url.password) reject();
    pool = new Pool({ host: url.hostname, port: Number(url.port || 5432), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: decodeURIComponent(url.pathname.slice(1)), ssl: url.searchParams.get('sslmode') === 'verify-full' ? { rejectUnauthorized: true } : false, max: 3, connectionTimeoutMillis: 5000, query_timeout: 10000, statement_timeout: 10000, application_name: 'adherence-history-manual-owner' });
    pool.on('error', abort);
    const deps = runtime(pool, options);
    // operate owns pool shutdown after adapters were successfully loaded.
    pool = undefined;
    const result = await operate(options, deps, controller.signal);
    console.log(JSON.stringify(result));
    process.exitCode = ['ready', 'stored'].includes(result.status) ? 0 : 1;
  } catch {
    console.log(JSON.stringify({ status: 'unknown', reasonCode: 'configuration_or_runtime_unavailable', stored: 0, unknown: 0 })); process.exitCode = 1;
  } finally {
    if (pool) await pool.end();
    process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
  }
}
module.exports = { validate, operate, rawSql, publisher, preflight, runtime };
if (require.main === module) void main();
