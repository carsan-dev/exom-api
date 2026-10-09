const fs = require('node:fs');
const { join, resolve } = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { Pool } = require('pg');
const { assertTestDatabase } = require('./test-database.cjs');
const { validateReport } = require('./run-integration.cjs');
const { validateSelection, PG_SUITES, onJestConfig } = require('./run-adherence-integration.cjs');
const ROOT = resolve(__dirname, '..');
const BASE = join(ROOT, 'docs/evidence/rest-t3a-20261005');
const MIGRATION = '20261005210000_add_weekly_recap_review_drafts_and_publication';
const SOURCES = ['prisma/schema.prisma', `prisma/migrations/${MIGRATION}/migration.sql`, 'test/recap-review-persistence.integration.spec.ts', 'scripts/run-recap-review-persistence.cjs', 'src/modules/recaps/recaps.service.ts', 'src/modules/recaps/recaps.service.spec.ts', '.gitignore'];
function assertOwned(row, owned) {
  const ports = row.NetworkSettings?.Ports?.['5432/tcp'];
  if (!/^sha256:[a-f0-9]{64}$/.test(owned.imageId) || row.Image !== owned.imageId || !/^[a-f0-9]{64}$/.test(owned.id) || row.Id !== owned.id || row.Name !== '/' + owned.name || !row.State?.Running || row.Config?.Labels?.['exom.scope'] !== owned.name || !row.Config?.Env?.includes('PGDATA=/var/lib/postgresql/exom-ci-data') || row.HostConfig?.Binds?.length || !Array.isArray(row.Mounts) || row.Mounts.some(m => m.Type !== 'tmpfs') || !row.HostConfig?.Tmpfs?.['/var/lib/postgresql/exom-ci-data'] || !row.HostConfig?.Tmpfs?.['/var/lib/postgresql/data'] || ports?.length !== 1 || ports[0].HostIp !== '127.0.0.1' || !/^\d+$/.test(ports[0].HostPort) || Number(ports[0].HostPort) < 1024 || Number(ports[0].HostPort) > 65535 || ports[0].HostPort === '55493' || (owned.port && owned.port !== ports[0].HostPort)) throw Error('Owned isolation identity mismatch');
  owned.port = ports[0].HostPort;
}
function validateProfile(report, mode, expected) {
  validateSelection(report, expected);
  if (!report.numPassedTests) throw Error('Incomplete test receipt');
  if (['concurrency', 'e2e'].includes(mode)) validateReport(report, mode);
  if (mode === 'all') {
    const required = ['adherence-history-baseline.concurrency.spec.ts', 'adherence-assignment-journal.concurrency.spec.ts', 'adherence-catalog-journal.concurrency.spec.ts', 'adherence-commit-resolver.concurrency.spec.ts', 'client-followup-tasks.http.spec.ts', 'client-followup-tasks.list.spec.ts', 'client-followup-tasks.pg.spec.ts'];
    for (const name of required) if (!report.testResults.some(result => result.name.endsWith(name) && result.status === 'passed' && result.assertionResults.length && result.assertionResults.every(test => test.status === 'passed'))) throw Error('Required full-suite coverage absent: ' + name);
  }
}
function run(command, args, env, directory, label) {
  const result = spawnSync(command, args, { cwd: ROOT, env, encoding: 'utf8', shell: false, maxBuffer: 50 * 1024 * 1024 });
  fs.writeFileSync(join(directory, label + '.log'), (result.stdout || '') + (result.stderr || ''));
  fs.writeFileSync(join(directory, label + '-command.json'), JSON.stringify({ command, args, exit: result.status }, null, 2));
  if (result.error || result.status !== 0) throw Error(`${label}: FAIL (exit ${result.status}); evidence ${directory}`);
  return result.stdout;
}
function environment(directory, source = process.env) {
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) if (source[key] !== undefined) env[key] = source[key];
  const preload = join(directory, 'privacy.cjs');
  fs.writeFileSync(preload, `const fs = require('node:fs'); const original = fs.readFileSync; fs.readFileSync = function(path, options) { if (/^\\.env(?:\\.|$)/.test(require('node:path').basename(String(path)))) return typeof options === 'string' || options?.encoding ? '' : Buffer.alloc(0); return original.apply(this, arguments); };`);
  fs.appendFileSync(preload, `\nconst net = require('node:net'); const connect = net.Socket.prototype.connect; net.Socket.prototype.connect = function(...args) { const raw = args[0]; const options = Array.isArray(raw) ? raw[0] : raw; const host = typeof options === 'object' ? options.host : typeof args[1] === 'string' ? args[1] : undefined; if (host && !['127.0.0.1', 'localhost', '::1'].includes(host)) throw Error('External provider connection forbidden in owned tests'); return connect.apply(this, args); };`);
  const empty = join(directory, 'empty.env');
  fs.writeFileSync(empty, '');
  return { ...env, NODE_ENV: 'test', HOST: '127.0.0.1', EXOM_SMOKE_DISABLE_SCHEDULERS: '1', DOTENV_CONFIG_PATH: empty, DATABASE_SSL_MODE: 'disable', NODE_OPTIONS: `--require="${preload.replaceAll('\\', '/')}"`, DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/exom_ci', PRISMA_DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/exom_ci', MSYS_NO_PATHCONV: '1', MSYS2_ARG_CONV_EXCL: '*' };
}
function snapshot(directory, after = false) {
  const hashes = {};
  const listed = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'src', 'test', 'prisma', 'scripts', '*.json', '*.cjs', '.gitignore'], { cwd: ROOT, encoding: 'utf8', shell: false });
  if (listed.status !== 0) throw Error('Source inventory unavailable');
  const paths = [...new Set([...SOURCES, ...listed.stdout.trim().split(/\r?\n/)])].filter(path => /\.(ts|cjs|json|prisma|sql)$/.test(path) || path === '.gitignore').sort();
  for (const path of paths) {
    if (!fs.existsSync(join(ROOT, path))) continue;
    const bytes = fs.readFileSync(join(ROOT, path));
    hashes[path] = createHash('sha256').update(bytes).digest('hex');
    if (!after) {
      const output = join(directory, 'sources', path + '.snapshot');
      fs.mkdirSync(resolve(output, '..'), { recursive: true });
      fs.writeFileSync(output, bytes, { flag: 'wx' });
    }
  }
  for (const path of ['../AGENTS.md', '../odd/tasks/progress-remaining-phases.md', '../docs/plans/progreso-clientes-plan.md', 'scripts/probe-client-deletion-lock-order.cjs']) hashes[path] = createHash('sha256').update(fs.readFileSync(join(ROOT, path))).digest('hex');
  const migrationHashes = {};
  for (const name of fs.readdirSync(join(ROOT, 'prisma/migrations')).filter(name => /^\d/.test(name)).sort()) {
    const bytes = fs.readFileSync(join(ROOT, 'prisma/migrations', name, 'migration.sql'));
    migrationHashes[name] = createHash('sha256').update(bytes).digest('hex');
  }
  fs.writeFileSync(join(directory, after ? 'manifest-after.json' : 'manifest.json'), JSON.stringify({ date: new Date().toISOString(), hashes, migrationHashes }, null, 2));
  if (after) {
    const before = JSON.parse(fs.readFileSync(join(directory, 'manifest.json'), 'utf8'));
    if (JSON.stringify(before.hashes) !== JSON.stringify(hashes) || JSON.stringify(before.migrationHashes) !== JSON.stringify(migrationHashes)) throw Error('Source bytes changed during verification');
  }
}
async function database(env, directory, mode) {
  const name = 'exom-rest-t3a-' + randomUUID();
  const password = randomUUID();
  const image = spawnSync('docker', ['image', 'inspect', 'postgres:17-bookworm', '--format', '{{.Id}}'], { env, encoding: 'utf8', shell: false });
  const imageId = image.stdout?.trim();
  if (image.status !== 0 || !/^sha256:[a-f0-9]{64}$/.test(imageId)) throw Error('Local PostgreSQL 17 image unavailable; no pull or fallback');
  const tracking = ['all', 'concurrency', 'e2e'].includes(mode) ? 'off' : 'on';
  // Do not persist docker inspect/config or the command containing its ephemeral password.
  const args = ['run', '--pull=never', '--detach', '--name', name, '--label', `exom.scope=${name}`, '--publish', '127.0.0.1::5432', '--tmpfs', '/var/lib/postgresql/exom-ci-data:rw', '--tmpfs', '/var/lib/postgresql/data:rw', '--env', 'POSTGRES_USER=exom_ci', '--env', `POSTGRES_PASSWORD=${password}`, '--env', 'POSTGRES_DB=exom_ci', '--env', 'PGDATA=/var/lib/postgresql/exom-ci-data', imageId, 'postgres', '-c', `track_commit_timestamp=${tracking}`];
  const result = spawnSync('docker', args, { env, encoding: 'utf8', shell: false });
  const id = result.stdout?.trim();
  if (result.status !== 0 || !/^[a-f0-9]{64}$/.test(id)) throw Error('Owned PostgreSQL creation failed; no fallback');
  const owned = { id, name, imageId };
  fs.writeFileSync(join(directory, 'created-resource.json'), JSON.stringify({ ...owned, retention: 'Retained even if preflight fails; never adopt or clean up' }, null, 2));
  // Inspect in memory only: docker config includes the ephemeral credential.
  const inspectSafe = () => {
    const result = spawnSync('docker', ['inspect', id], { env, encoding: 'utf8', shell: false });
    if (result.status !== 0) throw Error('Owned resource inspection unavailable');
    const row = JSON.parse(result.stdout)[0];
    assertOwned(row, owned);
  };
  inspectSafe();
  fs.writeFileSync(join(directory, 'resource.json'), JSON.stringify({ ...owned, tracking, role: 'exom_ci', dataDirectory: '/var/lib/postgresql/exom-ci-data', loopback: true, mounts: 'tmpfs only', imageIdentityVerifiedBeforeWrites: true, retention: 'Retained; no cleanup or shutdown' }, null, 2));
  for (let attempt = 0; attempt < 60; attempt++) {
    inspectSafe();
    // The initialization server accepts Unix sockets before its intentional restart.
    const ready = spawnSync('docker', ['exec', id, 'pg_isready', '-h', '127.0.0.1', '-U', 'exom_ci', '-d', 'exom_ci'], { env, stdio: 'ignore', shell: false });
    if (ready.status === 0) break;
    if (attempt === 59) throw Error('Owned PostgreSQL unavailable');
    await new Promise(r => setTimeout(r, 1000));
  }
  const url = `postgresql://exom_ci:${password}@127.0.0.1:${owned.port}/exom_ci`;
  const pool = new Pool({ connectionString: url, ssl: false });
  try {
    await assertTestDatabase(pool, url);
    inspectSafe();
    const { rows: [settings] } = await pool.query("SELECT current_setting('track_commit_timestamp') tracking, current_setting('server_version_num') version");
    if (settings.tracking !== tracking || Number(settings.version) < 170000 || Number(settings.version) >= 180000) throw Error('Owned PostgreSQL version/tracking mismatch');
    const { rows } = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
    if (rows.length) throw Error('Refusing populated owned cluster');
    fs.writeFileSync(join(directory, 'sql-preflight.json'), JSON.stringify({ database: 'exom_ci', role: 'exom_ci', dataDirectory: '/var/lib/postgresql/exom-ci-data', version: settings.version, tracking: settings.tracking, publicTablesBeforeWrites: rows.length, physicalIdentityVerifiedBeforeWrites: true }, null, 2));
    if (mode !== 'pg') {
      const names = fs.readdirSync(join(ROOT, 'prisma/migrations')).filter(name => /^\d/.test(name)).sort();
      if (names[84] !== '20261001040000_adherence_history_baseline') throw Error('Unexpected legacy84 boundary');
      if (tracking === 'off') {
      await pool.query('CREATE DATABASE exom_ci_history_legacy_7f814563');
      const legacyUrl = new URL(url);
      legacyUrl.pathname = '/exom_ci_history_legacy_7f814563';
      const legacy = new Pool({ connectionString: legacyUrl.toString(), ssl: false });
      try {
        inspectSafe();
        const { rows: [identity] } = await legacy.query("SELECT current_database() db,current_user role,current_setting('data_directory') dir");
        if (identity.db !== 'exom_ci_history_legacy_7f814563' || identity.role !== 'exom_ci' || identity.dir !== '/var/lib/postgresql/exom-ci-data') throw Error('Owned legacy identity mismatch');
        const { rows } = await legacy.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
        if (rows.length) throw Error('Refusing populated legacy database');
        for (const name of names.slice(0, 84)) await legacy.query(fs.readFileSync(join(ROOT, 'prisma/migrations', name, 'migration.sql'), 'utf8'));
      } finally { await legacy.end(); }
      }
      inspectSafe();
      for (const name of names) await pool.query(fs.readFileSync(join(ROOT, 'prisma/migrations', name, 'migration.sql'), 'utf8'));
      Object.assign(env, { DATABASE_URL: url, PRISMA_DATABASE_URL: url, DIRECT_URL: url, FOLLOWUP_SERVICE_PG: '1', FOLLOWUP_HTTP_PG: '1', EXOM_RESOLVER_TRACKING: tracking });
      if (tracking === 'off') Object.assign(env, { P4_HISTORY_NONCE: '7f814563-7e91-42ac-a869-4e9470a32d81', P4_HISTORY_LEGACY_DATABASE: 'exom_ci_history_legacy_7f814563' });
      else Object.assign(env, { EXOM_LEDGER_OWNED_RUN: name, EXOM_PRESCRIPTION_OWNED_RUN: name, EXOM_CUT_OWNED_CONTAINER: id, EXOM_CUT_OWNED_NAME: name });
      fs.writeFileSync(join(directory, 'migrations.json'), JSON.stringify({ names, count: names.length, legacyCount: tracking === 'off' ? 84 : 0, identityVerifiedBeforeWrites: true, tracking }, null, 2));
    } else {
      await pool.query('CREATE DATABASE exom_ci_recap_upgrade');
    }
  } finally { await pool.end(); }
  env.TEST_DATABASE_URL = url;
  const upgradeUrl = new URL(url);
  upgradeUrl.pathname = '/exom_ci_recap_upgrade';
  env.RECAP_UPGRADE_DATABASE_URL = upgradeUrl.toString();
  return inspectSafe;
}
async function main() {
  const mode = process.argv[2];
  if (!['unit', 'pg', 'checks', 'all', 'concurrency', 'e2e', 'adherence-on'].includes(mode)) throw Error('Expected unit, pg, checks, all, concurrency, e2e or adherence-on');
  fs.mkdirSync(BASE, { recursive: true });
  const directory = join(BASE, 'run-' + mode + '-' + randomUUID());
  fs.mkdirSync(directory);
  snapshot(directory);
  const env = environment(directory);
  console.log(`Evidence: ${directory}`);
  try {
  if (mode === 'checks') {
    run(process.execPath, [require.resolve('prisma/build/index.js'), 'generate'], env, directory, 'prisma-generate');
    run(process.execPath, [require.resolve('prisma/build/index.js'), 'validate'], env, directory, 'prisma-validate');
    run(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.build.json', '--outDir', join(directory, 'build'), '--incremental', 'false'], env, directory, 'tsc');
    run(process.execPath, [resolve(require.resolve('eslint/package.json'), '..', 'bin/eslint.js'), '{src,apps,libs,test}/**/*.ts', '--no-fix'], env, directory, 'lint');
    run('git', ['diff', '--check'], env, directory, 'diff-check');
    run(process.env.COMSPEC || 'cmd.exe', ['/d', '/s', '/c', 'npm run build'], env, directory, 'nest-build');
  } else {
    const inspectSafe = mode !== 'unit' ? await database(env, directory, mode) : undefined;
    const config = mode === 'e2e'
      ? { ...require('../test/jest-e2e.json'), rootDir: join(ROOT, 'test'), cacheDirectory: join(directory, 'cache') }
      : mode === 'adherence-on'
      ? { ...onJestConfig(), cacheDirectory: join(directory, 'cache') }
      : ['all', 'concurrency'].includes(mode)
      ? { ...require('../package.json').jest, rootDir: join(ROOT, 'src'), cacheDirectory: join(directory, 'cache') }
      : { rootDir: ROOT, testEnvironment: 'node', transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] }, cacheDirectory: join(directory, 'cache') };
    const test = mode === 'pg' ? 'test/recap-review-persistence.integration.spec.ts' : 'src/modules/recaps/recaps.service.spec.ts';
    const args = [require.resolve('jest/bin/jest'), '--config', JSON.stringify(config), '--runInBand', '--json', '--outputFile', join(directory, 'jest.json')];
    let expected;
    if (mode === 'concurrency') args.push('--testPathPatterns=concurrency');
    else if (mode === 'adherence-on') { expected = [...PG_SUITES, 'src/modules/adherence/adherence-commit-resolver.concurrency.spec.ts']; args.push('--runTestsByPath', ...expected); }
    else if (['unit', 'pg'].includes(mode)) { expected = [test]; args.push('--runTestsByPath', test); }
    if (!expected) expected = JSON.parse(run(process.execPath, [args[0], '--config', JSON.stringify(config), '--runInBand', '--listTests', '--json', ...(mode === 'concurrency' ? ['--testPathPatterns=concurrency'] : [])], env, directory, 'selection'));
    fs.writeFileSync(join(directory, 'selection.json'), JSON.stringify(expected, null, 2));
    if (['concurrency', 'e2e', 'adherence-on'].includes(mode)) args.push('--detectOpenHandles');
    try {
      run(process.execPath, args, env, directory, 'jest');
      const report = JSON.parse(fs.readFileSync(join(directory, 'jest.json'), 'utf8'));
      validateProfile(report, mode, expected);
      console.log(`${mode}: PASS ${report.numPassedTestSuites} suites / ${report.numPassedTests} tests, zero pending`);
    } finally {
      inspectSafe?.();
      if (inspectSafe) {
        const pool = new Pool({ connectionString: env.TEST_DATABASE_URL, ssl: false });
        try {
          await assertTestDatabase(pool, env.TEST_DATABASE_URL);
          const { rows } = await pool.query('SELECT datname AS database FROM pg_database WHERE NOT datistemplate ORDER BY datname');
          fs.writeFileSync(join(directory, 'retained-databases.json'), JSON.stringify(rows, null, 2));
        } finally { await pool.end(); }
      }
    }
  }
  } finally { snapshot(directory, true); }
}
module.exports = { assertOwned, environment, validateProfile };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
