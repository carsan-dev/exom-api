const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync, unlinkSync, rmdirSync, rmSync, lstatSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { Pool } = require('pg');
const { assertTestDatabase, validateDatabaseUrl } = require('./test-database.cjs');
const { validateReport } = require('./run-integration.cjs');
const ROOT = resolve(__dirname, '..');
const PG_SUITES = ['adherence-commit-ledger', 'adherence-evaluation', 'adherence-history-cut', 'adherence-history-origin', 'adherence-prescription'].map(n => `test/${n}.pg-spec.ts`);
const RESOLVER = 'src/modules/adherence/adherence-commit-resolver.concurrency.spec.ts';
const LEGACY = 'exom_ci_history_legacy_7f814563';
function childEnvironment(url, dotenvPath, source = process.env) {
  validateDatabaseUrl(url);
  const env = {};
  // No inherited service credentials, SSL overrides, NODE_OPTIONS or dotenv fallback.
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'CI']) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  return { ...env, NODE_ENV: 'test', TEST_DATABASE_URL: url, DATABASE_URL: url,
    DIRECT_URL: url, PRISMA_DATABASE_URL: url, DATABASE_SSL_MODE: 'disable',
    DOTENV_CONFIG_PATH: dotenvPath, MSYS_NO_PATHCONV: '1', MSYS2_ARG_CONV_EXCL: '*' };
}
function assertTracking(expected, actual) {
  if (!['on', 'off'].includes(expected) || actual !== expected) throw Error('Unexpected commit timestamp tracking');
}
function assertOwnedContainer(identity, owned, stopped = false) {
  const ports = identity.NetworkSettings?.Ports?.['5432/tcp'];
  const binding = identity.HostConfig?.PortBindings?.['5432/tcp'];
  const validPort = stopped
    ? identity.State?.Running === false && binding?.length === 1 && binding[0].HostIp === '127.0.0.1' && binding[0].HostPort === ''
    : ports?.length === 1 && ports[0].HostIp === '127.0.0.1' && ports[0].HostPort === owned.port;
  if (!/^[a-f0-9]{64}$/.test(owned.id) || identity.Id !== owned.id || identity.Name !== '/' + owned.name ||
      identity.Config?.Labels?.['exom.scope'] !== owned.name ||
      !identity.Config?.Env?.includes('PGDATA=/var/lib/postgresql/exom-ci-data') ||
      !identity.HostConfig?.Tmpfs?.['/var/lib/postgresql/exom-ci-data'] ||
      identity.HostConfig?.Binds?.length || identity.Mounts?.some(m => m.Type !== 'tmpfs') ||
      !validPort ||
      !/^\d+$/.test(owned.port) || Number(owned.port) < 1024 || Number(owned.port) > 65535 || owned.port === '55493') {
    throw Error('Owned container identity mismatch; no writes or cleanup permitted');
  }
}
function checkedChild(result) {
  if (result.error || result.status !== 0) throw Error(`Child failed (${result.status ?? result.signal ?? 'not started'})`);
  return result;
}
function validateSelection(report, expected) {
  const normalize = p => resolve(ROOT, p).replaceAll('\\', '/');
  const wanted = expected.map(normalize).sort();
  const actual = (report.testResults ?? []).map(r => normalize(r.name)).sort();
  if (report.success !== true || report.numPendingTests !== 0 || report.numTodoTests !== 0 ||
      report.numPendingTestSuites !== 0 || report.openHandles?.length ||
      !wanted.length || new Set(wanted).size !== wanted.length || JSON.stringify(actual) !== JSON.stringify(wanted) ||
      report.testResults.some(r => r.status !== 'passed' || !r.assertionResults?.length || r.assertionResults.some(a => a.status !== 'passed'))) {
    throw Error('Incomplete suite receipt: missing, skipped, duplicate or failed cases');
  }
}
function legacyPrefix(names) {
  const sorted = [...names].sort();
  if (sorted[84] !== '20261001040000_adherence_history_baseline') throw Error('Unexpected legacy84 migration boundary');
  return sorted.slice(0, 84);
}
function run(command, args, env, options = {}) {
  return checkedChild(spawnSync(command, args, { cwd: ROOT, env, windowsHide: true, shell: false, stdio: 'inherit', ...options }));
}
async function withDatabase(env, tracking, work) {
  const pool = new Pool({ connectionString: env.TEST_DATABASE_URL, ssl: false, connectionTimeoutMillis: 3000 });
  try {
    await assertTestDatabase(pool, env.TEST_DATABASE_URL);
    const { rows } = await pool.query("SELECT current_setting('track_commit_timestamp') AS tracking");
    assertTracking(tracking, rows[0].tracking);
    await work(pool);
  } finally { await pool.end(); }
}
async function prepareLegacy(env) {
  await withDatabase(env, 'off', async pool => {
    const { rows } = await pool.query('SELECT 1 FROM pg_database WHERE datname = $1', [LEGACY]);
    if (rows.length) throw Error('Legacy fixture already exists; refusing to adopt it');
    await pool.query(`CREATE DATABASE ${LEGACY}`);
  });
  const url = new URL(env.TEST_DATABASE_URL); url.pathname = '/' + LEGACY;
  const pool = new Pool({ connectionString: url.toString(), ssl: false });
  try {
    const { rows } = await pool.query("SELECT current_database() db, current_user role, current_setting('data_directory') dir");
    if (rows[0].db !== LEGACY || rows[0].role !== 'exom_ci' || rows[0].dir !== '/var/lib/postgresql/exom-ci-data') throw Error('Unexpected legacy fixture identity');
    const path = join(ROOT, 'prisma/migrations');
    for (const name of legacyPrefix(readdirSync(path).filter(n => /^\d/.test(n)))) {
      await pool.query(readFileSync(join(path, name, 'migration.sql'), 'utf8'));
    }
  } finally { await pool.end(); }
}
function onJestConfig() {
  const base = require('../package.json').jest;
  return { ...base, rootDir: ROOT, testRegex: '.*(?:\\.pg-spec|\\.concurrency\\.spec)\\.ts$',
    setupFilesAfterEnv: [join(ROOT, 'test/setup-database.ts')] };
}
function cleanOwnedCache(directory) {
  const cache = join(directory, 'cache');
  if (existsSync(cache)) {
    if (!lstatSync(cache).isDirectory() || lstatSync(cache).isSymbolicLink()) throw Error('Unexpected owned cache identity');
    rmSync(cache, { recursive: true }); // Only the cache inside our freshly allocated TEMP context.
  }
}
function jestRun(env, directory, label, args, expected, config) {
  const jest = require.resolve('jest/bin/jest');
  const common = ['--cacheDirectory', join(directory, 'cache'), ...(config ? ['--config', JSON.stringify(config)] : [])];
  if (!expected) {
    const listing = run(process.execPath, [jest, ...common, '--listTests', '--json', '--runInBand', ...args], env, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    expected = JSON.parse(listing.stdout);
  }
  const receipt = join(directory, label + '.json');
  try {
    run(process.execPath, [jest, ...common, ...args, '--runInBand', '--detectOpenHandles', '--json', '--outputFile', receipt], env);
    const report = JSON.parse(readFileSync(receipt, 'utf8'));
    validateSelection(report, expected);
    if (label === 'concurrency') validateReport(report, 'concurrency');
    console.log(`${label}: ${expected.length} suites, ${report.numPassedTests} tests, no skips`);
  } finally { if (existsSync(receipt)) unlinkSync(receipt); }
}
function inspectOwned(owned, env, stopped = false) {
  const output = run('docker', ['inspect', owned.id], env, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  const identities = JSON.parse(output.stdout);
  if (identities.length !== 1) throw Error('Ambiguous Docker identity');
  assertOwnedContainer(identities[0], owned, stopped);
}
async function ownedOn(directory, empty) {
  const name = 'exom-ci-' + randomUUID();
  const password = randomUUID(); // Fresh disposable credential, never printed.
  const dockerEnv = childEnvironment('postgresql://exom_ci:unused@127.0.0.1:5432/exom_ci', empty);
  let owned;
  try {
    const started = run('docker', ['run', '--detach', '--name', name, '--label', `exom.scope=${name}`,
      '--publish', '127.0.0.1::5432', '--tmpfs', '/var/lib/postgresql/exom-ci-data:rw',
      '--tmpfs', '/var/lib/postgresql/data:rw', // Override the image's anonymous VOLUME too.
      '--env', 'POSTGRES_USER=exom_ci', '--env', `POSTGRES_PASSWORD=${password}`, '--env', 'POSTGRES_DB=exom_ci',
      '--env', 'PGDATA=/var/lib/postgresql/exom-ci-data', 'postgres:17-bookworm', 'postgres', '-c', 'track_commit_timestamp=on'], dockerEnv,
    { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    const id = started.stdout.trim();
    if (!/^[a-f0-9]{64}$/.test(id)) throw Error('Missing full container ID; refusing cleanup');
    const output = run('docker', ['inspect', id], dockerEnv, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    const identity = JSON.parse(output.stdout)[0];
    owned = { id, name, port: identity?.NetworkSettings?.Ports?.['5432/tcp']?.[0]?.HostPort };
    inspectOwned(owned, dockerEnv);
    const url = `postgresql://exom_ci:${password}@127.0.0.1:${owned.port}/exom_ci`;
    const env = childEnvironment(url, empty);
    Object.assign(env, { EXOM_RESOLVER_TRACKING: 'on', EXOM_LEDGER_OWNED_RUN: name,
      EXOM_PRESCRIPTION_OWNED_RUN: name, EXOM_CUT_OWNED_CONTAINER: id, EXOM_CUT_OWNED_NAME: name });
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      inspectOwned(owned, dockerEnv);
      const check = spawnSync('docker', ['exec', id, 'pg_isready', '-U', 'exom_ci', '-d', 'exom_ci'], { env: dockerEnv, shell: false, stdio: 'ignore' });
      if (check.status === 0) { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (!ready) throw Error('Owned PostgreSQL did not become ready');
    await withDatabase(env, 'on', async () => {});
    inspectOwned(owned, dockerEnv);
    run(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'], env);
    const config = onJestConfig();
    const expected = [...PG_SUITES, RESOLVER];
    inspectOwned(owned, dockerEnv);
    jestRun(env, directory, 'adherence-on', ['--runTestsByPath', ...expected], expected, config);
  } finally {
    if (owned) {
      inspectOwned(owned, dockerEnv); // Fail closed: never remove by name or after identity mismatch.
      run('docker', ['stop', owned.id], dockerEnv, { stdio: 'ignore' });
      inspectOwned(owned, dockerEnv, true);
      run('docker', ['rm', owned.id], dockerEnv, { stdio: 'ignore' });
    }
  }
}
async function main(mode = process.argv[2]) {
  if (!['off', 'on'].includes(mode)) throw Error('Expected explicit off or on integration context');
  // Some existing unit cases temporarily exercise NODE_ENV=production. They must
  // not expose Nest's default .env reader to a developer's repository secrets.
  if (existsSync(join(ROOT, '.env'))) throw Error('Use a disposable checkout without a repository .env file');
  const directory = mkdtempSync(join(tmpdir(), `exom-adherence-${randomUUID()}-`));
  const empty = join(directory, 'empty.env');
  writeFileSync(empty, '');
  try {
    if (mode === 'on') { await ownedOn(directory, empty); return; }
    const env = childEnvironment(process.env.TEST_DATABASE_URL, empty);
    Object.assign(env, { EXOM_RESOLVER_TRACKING: 'off', P4_HISTORY_NONCE: '7f814563-7e91-42ac-a869-4e9470a32d81', P4_HISTORY_LEGACY_DATABASE: LEGACY });
    await prepareLegacy(env);
    jestRun(env, directory, 'unit', [], undefined);
    jestRun(env, directory, 'concurrency', ['--testPathPatterns=concurrency'], undefined);
  } finally {
    cleanOwnedCache(directory);
    unlinkSync(empty);
    rmdirSync(directory);
  }
}
module.exports = { childEnvironment, assertOwnedContainer, assertTracking, validateSelection, checkedChild, legacyPrefix, PG_SUITES, onJestConfig, cleanOwnedCache };
if (require.main === module) {
  let complete = false;
  process.on('beforeExit', () => { if (!complete) { console.error('Adherence integration did not complete'); process.exitCode = 1; } });
  main().then(() => { complete = true; }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
