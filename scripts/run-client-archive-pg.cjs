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
const eligibilityMigration = '20261009190000_p5fu05_global_challenge_eligibility_periods';
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

async function main(legacyUpgrade = false) {
  const owner = `archive-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  const container = `exom-${owner}`;
  const volume = `${container}-data`;
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'exom-archive-pg-'));
  const password = crypto.randomBytes(32).toString('hex');
  let url;
  const env = cleanEnv();
  const manifest = {
    owner, container, volume, output, startedUtc: new Date().toISOString(),
    dataDir, database: 'exom_ci', user: 'exom_ci', legacyUpgrade, status: 'IN_PROGRESS', commands: [],
    sourceHashes: Object.fromEntries([
      'scripts/run-client-archive-pg.cjs', fixture, 'scripts/test-database.cjs',
      'test/setup-database.ts', 'prisma.config.ts', 'package.json',
      'prisma/schema.prisma', `prisma/migrations/${eligibilityMigration}/migration.sql`,
      'src/modules/challenges/challenges.service.ts', 'src/modules/challenges/challenge-progress.ts',
      'src/modules/streaks/streak-calculator.service.ts',
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
    if (legacyUpgrade) {
      const migrations = path.join(output, 'legacy-migrations');
      fs.mkdirSync(migrations);
      for (const entry of fs.readdirSync(path.join(root, 'prisma/migrations'))) {
        if (entry !== eligibilityMigration) fs.cpSync(path.join(root, 'prisma/migrations', entry), path.join(migrations, entry), { recursive: true });
      }
      const schema = path.join(output, 'legacy.prisma');
      fs.writeFileSync(schema, command('git', ['show', 'HEAD:prisma/schema.prisma']));
      const config = path.join(output, 'legacy.config.cjs');
      fs.writeFileSync(config, `module.exports = {schema: ${JSON.stringify(schema)}, migrations: {path: ${JSON.stringify(migrations)}}, datasource: {url: process.env.PRISMA_DATABASE_URL}};`);
      command(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy', '--config', config], childEnv);
      const legacy = new Pool({ connectionString: url });
      const migration = fs.readFileSync(path.join(root, 'prisma/migrations', eligibilityMigration, 'migration.sql'), 'utf8');
      async function snapshot() {
        const tables = await legacy.query(`SELECT tablename FROM pg_tables WHERE schemaname='public'
          AND tablename NOT IN ('_prisma_migrations','challenge_client_eligibility_periods') ORDER BY tablename`);
        const rows = {};
        for (const { tablename } of tables.rows) {
          assert(/^[a-z_]+$/.test(tablename), 'Unsafe snapshot identifier');
          rows[tablename] = (await legacy.query(`SELECT (to_jsonb(t)-'challenge_activity'-'challenge_activity_at') AS value FROM "${tablename}" t ORDER BY (to_jsonb(t)-'challenge_activity'-'challenge_activity_at')::text`)).rows;
        }
        return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
      }
      try {
        await assertTestDatabase(legacy, url);
        const a = `${owner}-legacy-admin`, c = `${owner}-legacy-client`, i = `${owner}-legacy-inactive`;
        await legacy.query(`INSERT INTO users(id,firebase_uid,email,role,updated_at) VALUES
          ($1,$1,$1||'@example.test','ADMIN',now()),($2,$2,$2||'@example.test','CLIENT',now()),($3,$3,$3||'@example.test','CLIENT',now())`, [a,c,i]);
        await legacy.query(`INSERT INTO admin_client_assignments(id,admin_id,client_id,is_active) VALUES ($1,$2,$3,true),($4,$2,$5,false)`, [`${owner}-aca`,a,c,`${owner}-aca-inactive`,i]);
        await legacy.query(`INSERT INTO challenges(id,title,description,type,target_value,unit,is_manual,is_global,created_by,updated_at)
          VALUES ($1,'legacy','own fixture','MAIN_GOAL',10,'days',true,true,$2,now()),($3,'manual','own fixture','MAIN_GOAL',10,'days',true,false,$2,now())`, [`${owner}-global`,a,`${owner}-manual`]);
        await legacy.query(`INSERT INTO challenge_clients(id,challenge_id,client_id,assignment_source,current_value,is_completed,completed_at,assigned_at)
          VALUES ($1,$2,$3,'GLOBAL',10,true,'2026-09-03','2026-09-02'),($4,$2,$5,'GLOBAL',7,false,NULL,'2026-09-02'),($6,$7,$3,'MANUAL',9,false,NULL,'2026-09-02')`,
        [`${owner}-cc`,`${owner}-global`,c,`${owner}-cc-inactive`,i,`${owner}-cc-manual`,`${owner}-manual`]);
        await legacy.query(`INSERT INTO body_metrics(id,client_id,date,weight_kg) VALUES($1,$2,'2026-09-02',70)`,[`${owner}-metric`,c]);
        await legacy.query(`INSERT INTO day_progress(id,client_id,date,training_completed,meals_completed,updated_at) VALUES($1,$2,'2026-09-02',true,ARRAY['own-meal'],now())`,[`${owner}-progress`,c]);
        await legacy.query(`INSERT INTO challenges(id,title,description,type,target_value,unit,is_manual,is_global,updated_at)
          VALUES ($1,'non-client legacy','own fixture','MAIN_GOAL',10,'days',true,true,now())`, [`${owner}-non-client-global`]);
        await legacy.query(`INSERT INTO challenge_clients(id,challenge_id,client_id,assignment_source,current_value,assigned_at)
          VALUES ($1,$2,$3,'GLOBAL',6,'2026-09-02')`, [`${owner}-non-client-cc`,`${owner}-non-client-global`,a]);
        manifest.legacyBeforeHash = await snapshot();
        let rolledBack = false;
        try { await legacy.query(migration.replace(/COMMIT;\s*$/, 'SELECT 1/0; COMMIT;')); }
        catch (error) { assert(error.code === '22012', 'Unexpected rollback cause'); await legacy.query('ROLLBACK'); rolledBack = true; }
        assert(rolledBack && await snapshot() === manifest.legacyBeforeHash, 'Failed migration changed protected legacy rows');
        assert((await legacy.query(`SELECT to_regclass('public.challenge_client_eligibility_periods') AS value`)).rows[0].value === null, 'Failed migration retained new table');
        manifest.legacyRollback = 'PASS';
        command(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], childEnv);
        manifest.legacyAfterHash = await snapshot();
        assert(manifest.legacyAfterHash === manifest.legacyBeforeHash, 'Upgrade changed protected history');
        const periods = (await legacy.query(`SELECT challenge_client_id,baseline_value,starts_on,
          starts_on = (clock_timestamp() AT TIME ZONE 'UTC')::date + 1 AS conservative_start FROM challenge_client_eligibility_periods`)).rows;
        assert(periods.length === 1 && periods[0].challenge_client_id === `${owner}-cc` && periods[0].baseline_value === 10 && periods[0].conservative_start, 'Wrong eligibility backfill');
        const unknown = (await legacy.query(`SELECT bm.challenge_activity_at IS NULL AS metric_unknown, dp.challenge_activity = '{}'::jsonb AS progress_unknown
          FROM body_metrics bm JOIN day_progress dp ON dp.client_id=bm.client_id WHERE bm.id=$1`,[`${owner}-metric`])).rows[0];
        assert(unknown.metric_unknown && unknown.progress_unknown, 'Legacy provenance was fabricated');
        command(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], childEnv);
        assert(await snapshot() === manifest.legacyBeforeHash && (await legacy.query('SELECT count(*)::int AS n FROM challenge_client_eligibility_periods')).rows[0].n === 1, 'Migration replay was not idempotent');
        manifest.legacyUpgrade = 'PASS';
      } finally { await legacy.end(); }
    } else command(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], childEnv);
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
    manifest.finalSourceHashes = Object.fromEntries(Object.keys(manifest.sourceHashes).map((file) => [file, hash(path.join(root, file))]));
    assert(JSON.stringify(manifest.finalSourceHashes) === JSON.stringify(manifest.sourceHashes), 'Sources changed during verification');
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
else if (process.argv.length === 3 && process.argv[2] === '--legacy-upgrade') main(true).catch(() => { console.error('Launcher failed'); process.exitCode = 1; });
else { console.error('Usage: node scripts/run-client-archive-pg.cjs [--self-check|--legacy-upgrade]'); process.exitCode = 1; }
