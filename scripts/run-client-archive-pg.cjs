'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { Pool } = require('pg');
const { validateDatabaseUrl, assertTestDatabase } = require('./test-database.cjs');

const root = path.resolve(__dirname, '..');
const fixture = 'src/modules/users/client-archive.concurrency.spec.ts';
const dataDir = '/var/lib/postgresql/exom-ci-data';
const label = 'exom.archive.owner';
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const assert = (condition, message) => { if (!condition) throw Error(message); };

// Only OS/tool-discovery variables survive; never inherit dotenv, credentials or Node hooks.
function cleanEnv() {
  const env = {};
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LOCALAPPDATA']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function checkReport(report) {
  assert(report.success === true && report.numPassedTests >= 9 &&
    report.numTotalTests === report.numPassedTests && report.numFailedTests === 0 &&
    report.numPendingTests === 0 && report.numTodoTests === 0 &&
    report.numRuntimeErrorTestSuites === 0 && report.numTotalTestSuites === 1 &&
    report.numPassedTestSuites === 1 && Array.isArray(report.openHandles) &&
    report.openHandles.length === 0, 'Archive report did not prove >=9 passes without omissions/open handles');
  assert(report.testResults.length === 1 &&
    report.testResults[0].assertionResults.length === report.numPassedTests &&
    report.testResults[0].assertionResults.every((test) => test.status === 'passed'),
  'Archive assertions are missing or not all passed');
}

function selfCheck() {
  const good = {
    success: true, numPassedTests: 9, numTotalTests: 9, numFailedTests: 0,
    numPendingTests: 0, numTodoTests: 0, numRuntimeErrorTestSuites: 0,
    numTotalTestSuites: 1, numPassedTestSuites: 1, openHandles: [],
    testResults: [{ assertionResults: Array.from({ length: 9 }, () => ({ status: 'passed' })) }],
  };
  checkReport(good);
  let rejected = 0;
  for (const patch of [{ numPassedTests: 0 }, { numPendingTests: 1 }, { numTodoTests: 1 },
    { numFailedTests: 1 }, { openHandles: [{}] }, { success: false }, { testResults: [] }]) {
    try { checkReport({ ...good, ...patch }); } catch { rejected++; }
  }
  assert(rejected === 7, 'Report rejection self-check failed');
  for (const value of [undefined, 'postgres://exom_ci:x@127.0.0.1:55493/exom_ci',
    'postgres://exom_ci:x@localhost:55000/exom_ci']) {
    let denied = false;
    try { validateDatabaseUrl(value); } catch { denied = true; }
    assert(denied, 'Existing URL guard rejection failed');
  }
  console.log('PASS: report acceptance + 7 negative reports + 3 unsafe URL rejections');
}

async function main() {
  const owner = `archive-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  const container = `exom-${owner}`;
  const volume = `${container}-data`;
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'exom-archive-pg-'));
  const password = crypto.randomBytes(32).toString('hex');
  let url;
  const env = cleanEnv();
  const manifest = {
    owner, container, volume, output, startedUtc: new Date().toISOString(),
    dataDir, database: 'exom_ci', user: 'exom_ci', status: 'IN_PROGRESS', commands: [],
    sourceHashes: Object.fromEntries([
      'scripts/run-client-archive-pg.cjs', fixture, 'scripts/test-database.cjs',
      'test/setup-database.ts', 'prisma.config.ts', 'package.json',
    ].map((file) => [file, hash(path.join(root, file))])),
  };
  const receipt = path.join(output, 'manifest.json');
  const save = () => fs.writeFileSync(receipt, JSON.stringify(manifest, null, 2) + '\n');
  const redact = (text) => String(text).split(password).join('[REDACTED]')
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, '[DATABASE_URI_REDACTED]');
  function command(bin, args, childEnv = env, timeout = 120000) {
    // All arguments are nonsecret; Docker receives the password by environment only.
    const result = spawnSync(bin, args, { cwd: root, env: childEnv, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 });
    const index = manifest.commands.length + 1;
    const log = path.join(output, `${index}.log`);
    fs.writeFileSync(log, redact((result.stdout || '') + (result.stderr || '')));
    manifest.commands.push({ command: [bin, ...args], exit: result.status, log });
    save();
    assert(!result.error && result.status === 0, `Command ${index} failed; see ${log}`);
    return result.stdout.trim();
  }
  const docker = (args) => command('docker', args);
  try {
    save();
    manifest.base = command('git', ['rev-parse', 'HEAD']);
    manifest.image = docker(['image', 'inspect', 'postgres:17', '--format', '{{.Id}}']);
    assert(/^sha256:[a-f0-9]{64}$/.test(manifest.image), 'Invalid cached image identity');
    assert(docker(['volume', 'ls', '--filter', `name=^${volume}$`, '--format', '{{.Name}}']) === '', 'Volume name already exists');
    docker(['volume', 'create', '--label', `${label}=${owner}`, '--name', volume]);
    const created = JSON.parse(docker(['volume', 'inspect', volume]))[0];
    assert(created.Name === volume && created.Labels?.[label] === owner, 'Volume ownership mismatch');
    manifest.containerId = command('docker', ['create', '--pull', 'never', '--name', container,
      '--label', `${label}=${owner}`, '--network', 'bridge',
      '--publish', '127.0.0.1::5432', '--mount', `type=volume,source=${volume},target=${dataDir}`,
      '--tmpfs', '/var/lib/postgresql/data',
      '--env', `PGDATA=${dataDir}`, '--env', 'POSTGRES_DB=exom_ci', '--env', 'POSTGRES_USER=exom_ci',
      '--env', 'POSTGRES_PASSWORD', manifest.image], { ...env, POSTGRES_PASSWORD: password });
    docker(['start', container]);
    // Select safe metadata only: full docker inspect would disclose Config.Env/password.
    const metadata = JSON.parse(docker(['inspect', '--format',
      '{{json .Id}}|{{json .Image}}|{{json .Config.Labels}}|{{json .Mounts}}|{{json .NetworkSettings.Ports}}|{{json .HostConfig.Tmpfs}}', container])
      .split('|').map((part) => part.trim()).join(',' ).replace(/^/, '[').replace(/$/, ']'));
    const [id, image, labels, mounts, ports, tmpfs] = metadata;
    assert(id === manifest.containerId && image === manifest.image && labels[label] === owner, 'Container identity mismatch');
    const ownedMount = mounts.find((mount) => mount.Destination === dataDir);
    assert(mounts.length === 1 && ownedMount?.Type === 'volume' && ownedMount.Name === volume &&
      ownedMount.RW === true && Object.keys(tmpfs).length === 1 &&
      Object.hasOwn(tmpfs, '/var/lib/postgresql/data'), 'Mount mismatch');
    const bindings = ports['5432/tcp'];
    assert(Object.keys(ports).length === 1 && bindings?.length === 1 &&
      bindings[0].HostIp === '127.0.0.1', 'Port binding is not exclusively loopback');
    const port = Number(bindings[0].HostPort);
    assert(Number.isInteger(port) && port > 0 && port <= 65535 && port !== 55493, 'Forbidden/invalid port');
    manifest.port = port;
    url = `postgresql://exom_ci:${password}@127.0.0.1:${port}/exom_ci`;
    validateDatabaseUrl(url);
    const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 2000 });
    try {
      let ready = false;
      for (let attempt = 0; attempt < 60 && !ready; attempt++) {
        try { await pool.query('SELECT 1'); ready = true; }
        catch { await new Promise((resolve) => setTimeout(resolve, 1000)); }
      }
      assert(ready, 'New cluster did not become ready');
      await assertTestDatabase(pool, url);
      const { rows: [row] } = await pool.query(`SELECT count(*)::int AS tables FROM pg_class c
        JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p')`);
      assert(row.tables === 0, 'New database was not empty');
      manifest.sqlIdentityVerified = true;
      manifest.initialPublicTables = row.tables;
    } finally { await pool.end(); }
    const emptyDotenv = path.join(output, 'empty.env');
    fs.writeFileSync(emptyDotenv, '');
    const preload = path.join(output, 'network-guard.cjs');
    // The only JS TCP destination is the owned PG. HTTP/fetch/TLS cannot reach providers.
    fs.writeFileSync(preload, `'use strict';
const net = require('node:net');
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const normalized = Array.isArray(args[0]) ? args[0] : net._normalizeArgs(args);
  const options = normalized[0];
  if (options.host !== '127.0.0.1' || Number(options.port) !== ${port} || options.path)
    throw Error('External network denied by archive launcher');
  return connect.apply(this, args);
};
const deny = () => { throw Error('External provider denied by archive launcher'); };
for (const name of ['node:http', 'node:https']) {
  const module = require(name); module.request = deny; module.get = deny;
}
require('node:tls').connect = deny;
globalThis.fetch = deny;
`);
    const childEnv = {
      ...env, NODE_ENV: 'test', CI: 'true', DOTENV_CONFIG_PATH: emptyDotenv,
      TEST_DATABASE_URL: url, DATABASE_URL: url, PRISMA_DATABASE_URL: url,
      NODE_OPTIONS: `--require="${preload.replaceAll('\\', '/')}"`, CHECKPOINT_DISABLE: '1',
      PRISMA_HIDE_UPDATE_MESSAGE: '1',
    };
    save();
    command(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], childEnv);
    const reportPath = path.join(output, 'jest.json');
    command(process.execPath, ['node_modules/jest/bin/jest.js', '--runInBand', '--no-cache',
      '--runTestsByPath', fixture, '--detectOpenHandles', '--json', '--outputFile', reportPath,
      '--cacheDirectory', path.join(output, 'jest-cache')], childEnv, 180000);
    const reportText = redact(fs.readFileSync(reportPath, 'utf8'));
    fs.writeFileSync(reportPath, reportText);
    const report = JSON.parse(reportText);
    checkReport(report);
    manifest.passed = report.numPassedTests;
    manifest.failed = report.numFailedTests;
    manifest.skipped = report.numPendingTests;
    manifest.todo = report.numTodoTests;
    manifest.openHandles = report.openHandles.length;
    manifest.status = 'PASS';
  } catch (error) {
    manifest.status = 'FAIL';
    manifest.error = redact(error.message);
    process.exitCode = 1;
  } finally {
    manifest.finishedUtc = new Date().toISOString();
    save();
    console.log(`${manifest.status}: ${receipt}`);
    console.log(`Retained owned container ${container}, volume ${volume}`);
  }
}

if (process.argv.length === 3 && process.argv[2] === '--self-check') selfCheck();
else if (process.argv.length === 2) main().catch(() => { console.error('Launcher failed'); process.exitCode = 1; });
else { console.error('Usage: node scripts/run-client-archive-pg.cjs [--self-check]'); process.exitCode = 1; }
