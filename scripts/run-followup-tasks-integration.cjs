const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const { resolve, join } = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { Pool } = require('pg');
const { assertTestDatabase } = require('./test-database.cjs');
const ROOT = resolve(__dirname, '..');
const evidenceRoot = process.env.FOLLOWUP_EVIDENCE_ROOT ?? (process.argv[2] === 'http' ? 'docs/evidence/rest-t2c-20261005' : 'docs/evidence/rest-t2b-20261005');
if (!['docs/evidence/rest-t2b-20261005', 'docs/evidence/rest-t2c-20261005'].includes(evidenceRoot)) throw Error('Unapproved evidence root');
const BASE = join(ROOT, evidenceRoot);
const targets = ['src/modules/client-followup-tasks/client-followup-tasks.service.ts', 'src/modules/client-followup-tasks/client-followup-tasks.service.spec.ts', 'scripts/probe-client-deletion-lock-order.cjs'];
function preserveNoncompilableSnapshots() {
  const renamed = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw Error('Refusing snapshot symlink');
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith('.ts')) {
        const hash = createHash('sha256').update(fs.readFileSync(path)).digest('hex');
        let output = path + '.snapshot';
        if (fs.existsSync(output)) output += '-' + randomUUID();
        fs.renameSync(path, output); // Preserve bytes; never overwrite or delete a copy.
        if (createHash('sha256').update(fs.readFileSync(output)).digest('hex') !== hash) throw Error('Snapshot hash mismatch');
        renamed.push({ previous: path.slice(BASE.length + 1).replaceAll('\\', '/'), preserved: output.slice(BASE.length + 1).replaceAll('\\', '/'), sha256: hash });
      }
    }
  }
  walk(BASE);
  for (const entry of fs.readdirSync(BASE, { withFileTypes: true })) {
    if (!entry.isDirectory() || !(entry.name === 'before' || entry.name.startsWith('after-'))) continue;
    const manifest = join(BASE, entry.name, 'manifest.json');
    if (!fs.existsSync(manifest)) continue;
    const contents = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    contents.snapshot_paths ??= {};
    for (const path of Object.keys(contents.hashes)) {
      const relative = path.endsWith('.ts') ? path + '.snapshot' : path;
      const output = join(BASE, entry.name, relative);
      if (!fs.existsSync(output)) continue; // Coordination entries are hash-only references.
      if (createHash('sha256').update(fs.readFileSync(output)).digest('hex') !== contents.hashes[path]) throw Error('Checkpoint manifest hash mismatch');
      contents.snapshot_paths[path] = relative;
    }
    fs.writeFileSync(manifest, JSON.stringify(contents, null, 2));
  }
  if (renamed.length) fs.writeFileSync(join(BASE, 'snapshot-renames-' + randomUUID() + '.json'), JSON.stringify({ date: new Date().toISOString(), renamed }, null, 2));
}
function checkpoint(label) {
  const dir = join(BASE, label);
  if (fs.existsSync(dir)) return;
  fs.mkdirSync(dir, { recursive: true });
  const hashes = {};
  const snapshot_paths = {};
  const httpSources = evidenceRoot.endsWith('rest-t2c-20261005') ? ['.gitignore', 'src/app.module.ts', 'src/modules/client-followup-tasks/client-followup-tasks.controller.ts', 'src/modules/client-followup-tasks/client-followup-tasks.module.ts', 'src/modules/client-followup-tasks/client-followup-tasks.http.spec.ts', 'src/modules/client-followup-tasks/dto/client-followup-task.dto.ts'] : [];
  const selected = [...targets, 'scripts/run-followup-tasks-integration.cjs', 'src/modules/client-followup-tasks/client-followup-tasks.pg.spec.ts', ...httpSources].filter(path => fs.existsSync(join(ROOT, path)));
  for (const path of selected) {
    const bytes = fs.readFileSync(join(ROOT, path));
    const relative = path.endsWith('.ts') ? path + '.snapshot' : path;
    const output = join(dir, relative);
    fs.mkdirSync(resolve(output, '..'), { recursive: true });
    fs.writeFileSync(output, bytes, { flag: 'wx' });
    hashes[path] = createHash('sha256').update(bytes).digest('hex');
    snapshot_paths[path] = relative;
  }
  for (const path of ['../AGENTS.md', '../odd/tasks/progress-remaining-phases.md', '../docs/plans/progreso-clientes-plan.md']) hashes[path] = createHash('sha256').update(fs.readFileSync(join(ROOT, path))).digest('hex');
  fs.writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ date: new Date().toISOString(), hashes, snapshot_paths }, null, 2));
}
function run(command, args, env, log) {
  const result = spawnSync(command, args, { cwd: ROOT, env, shell: false, encoding: 'utf8', windowsHide: true, maxBuffer: 50 * 1024 * 1024 });
  if (log) fs.writeFileSync(log, (result.stdout || '') + (result.stderr || ''));
  if (result.error || result.status !== 0) throw Error(`Command failed: ${command} (exit ${result.status}); see ${log || 'preflight'}`);
  return result.stdout;
}
function environment(directory) {
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) if (process.env[key] !== undefined) env[key] = process.env[key];
  const empty = join(directory, 'empty.env');
  fs.writeFileSync(empty, '');
  const preload = join(directory, 'privacy.cjs');
  fs.writeFileSync(preload, `const fs = require('node:fs'); const original = fs.readFileSync; const root = ${JSON.stringify(ROOT)}; fs.readFileSync = function(path, options) { const p = require('node:path').resolve(String(path)); if (p.startsWith(root + require('node:path').sep) && /^\\.env(?:\\.|$)/.test(require('node:path').basename(p))) return typeof options === 'string' || options?.encoding ? '' : Buffer.alloc(0); return original.apply(this, arguments); };`);
  return { ...env, NODE_ENV: 'test', DOTENV_CONFIG_PATH: empty, NODE_OPTIONS: `--require="${preload.replaceAll('\\', '/')}"`, DATABASE_SSL_MODE: 'disable', MSYS_NO_PATHCONV: '1', MSYS2_ARG_CONV_EXCL: '*' };
}
function inspect(owned, env) {
  const rows = JSON.parse(run('docker', ['inspect', owned.id], env));
  const row = rows[0];
  const ports = row?.NetworkSettings?.Ports?.['5432/tcp'];
  if (rows.length !== 1 || row.Id !== owned.id || row.Name !== '/' + owned.name || !row.State.Running || row.Config.Labels?.['exom.scope'] !== owned.name || !row.Config.Env.includes('PGDATA=/var/lib/postgresql/exom-ci-data') || row.HostConfig.Binds?.length || row.Mounts.some(m => m.Type !== 'tmpfs') || !row.HostConfig.Tmpfs?.['/var/lib/postgresql/exom-ci-data'] || ports?.length !== 1 || ports[0].HostIp !== '127.0.0.1' || ports[0].HostPort !== owned.port) throw Error('Owned disposable resource identity mismatch');
}
async function database(directory, env, mode) {
  const name = (evidenceRoot.endsWith('rest-t2c-20261005') ? 'exom-rest-t2c-' : 'exom-rest-t2b-') + randomUUID();
  const password = randomUUID();
  const id = run('docker', ['run', '--detach', '--name', name, '--label', `exom.scope=${name}`, '--publish', '127.0.0.1::5432', '--tmpfs', '/var/lib/postgresql/exom-ci-data:rw', '--tmpfs', '/var/lib/postgresql/data:rw', '--env', 'POSTGRES_USER=exom_ci', '--env', `POSTGRES_PASSWORD=${password}`, '--env', 'POSTGRES_DB=exom_ci', '--env', 'PGDATA=/var/lib/postgresql/exom-ci-data', 'postgres:17-bookworm', 'postgres', '-c', `track_commit_timestamp=${mode === 'all' ? 'off' : 'on'}`], env).trim();
  if (!/^[a-f0-9]{64}$/.test(id)) throw Error('Missing owned container ID');
  const row = JSON.parse(run('docker', ['inspect', id], env))[0];
  const owned = { id, name, port: row.NetworkSettings.Ports['5432/tcp'][0].HostPort };
  inspect(owned, env);
  fs.writeFileSync(join(directory, 'resource.json'), JSON.stringify({ ...owned, database: 'exom_ci', role: 'exom_ci', dataDirectory: '/var/lib/postgresql/exom-ci-data', retention: 'Retained; no stop/delete/cleanup performed' }, null, 2));
  const url = `postgresql://exom_ci:${password}@127.0.0.1:${owned.port}/exom_ci`;
  Object.assign(env, { DATABASE_URL: url, PRISMA_DATABASE_URL: url, DIRECT_URL: url, TEST_DATABASE_URL: url, FOLLOWUP_SERVICE_PG: '1', FOLLOWUP_HTTP_PG: ['http', 'all'].includes(mode) ? '1' : '0' });
  for (let attempt = 0; attempt < 60; attempt++) {
    inspect(owned, env);
    const ready = spawnSync('docker', ['exec', id, 'pg_isready', '-U', 'exom_ci', '-d', 'exom_ci'], { env, shell: false, stdio: 'ignore' });
    if (ready.status === 0) break;
    if (attempt === 59) throw Error('Owned PostgreSQL unavailable');
    await new Promise(r => setTimeout(r, 1000));
  }
  const pool = new Pool({ connectionString: url, ssl: false });
  try {
    await assertTestDatabase(pool, url);
    inspect(owned, env);
    const tables = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
    if (tables.rows.length) throw Error('Refusing non-empty cluster');
    const names = fs.readdirSync(join(ROOT, 'prisma/migrations')).filter(n => /^\d/.test(n)).sort();
    if (mode === 'all') {
      if (names[84] !== '20261001040000_adherence_history_baseline') throw Error('Unexpected legacy84 boundary');
      await pool.query('CREATE DATABASE exom_ci_history_legacy_7f814563');
      const legacyUrl = new URL(url); legacyUrl.pathname = '/exom_ci_history_legacy_7f814563';
      const legacy = new Pool({ connectionString: legacyUrl.toString(), ssl: false });
      try {
        const { rows: [identity] } = await legacy.query("SELECT current_database() db,current_user role,current_setting('data_directory') dir");
        if (identity.db !== 'exom_ci_history_legacy_7f814563' || identity.role !== 'exom_ci' || identity.dir !== '/var/lib/postgresql/exom-ci-data') throw Error('Unexpected owned legacy database identity');
        for (const migration of names.slice(0, 84)) await legacy.query(fs.readFileSync(join(ROOT, 'prisma/migrations', migration, 'migration.sql'), 'utf8'));
      } finally { await legacy.end(); }
      Object.assign(env, { EXOM_RESOLVER_TRACKING: 'off', P4_HISTORY_NONCE: '7f814563-7e91-42ac-a869-4e9470a32d81', P4_HISTORY_LEGACY_DATABASE: 'exom_ci_history_legacy_7f814563' });
    }
    for (const migration of names) await pool.query(fs.readFileSync(join(ROOT, 'prisma/migrations', migration, 'migration.sql'), 'utf8'));
    fs.writeFileSync(join(directory, 'migrations.json'), JSON.stringify({ count: names.length, names, identityVerifiedBeforeWrites: true }, null, 2));
  } finally { await pool.end(); }
}
async function main() {
  const mode = process.argv[2];
  if (!['unit', 'pg', 'http', 'all'].includes(mode)) throw Error('Expected unit, pg, http or all');
  fs.mkdirSync(BASE, { recursive: true });
  // Historical T2B migration is legacy-only; never scan T2C build output or old receipts.
  if (evidenceRoot.endsWith('rest-t2b-20261005')) preserveNoncompilableSnapshots();
  checkpoint('before');
  const directory = join(BASE, mode + '-' + randomUUID());
  fs.mkdirSync(directory);
  const env = environment(directory);
  if (mode !== 'unit') await database(directory, env, mode);
  else Object.assign(env, { DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/exom_ci', PRISMA_DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/exom_ci' });
  const config = { ...require('../package.json').jest, rootDir: join(ROOT, 'src'), cacheDirectory: join(directory, 'cache') };
  const args = [require.resolve('jest/bin/jest'), '--config', JSON.stringify(config), '--runInBand', '--json', '--outputFile', join(directory, 'jest.json')];
  if (mode === 'unit') args.push('--runTestsByPath', 'src/modules/client-followup-tasks/client-followup-tasks.service.spec.ts');
  if (mode === 'pg') args.push('--runTestsByPath', 'src/modules/client-followup-tasks/client-followup-tasks.pg.spec.ts');
  if (mode === 'http') args.push('--runTestsByPath', 'src/modules/client-followup-tasks/client-followup-tasks.http.spec.ts');
  try { run(process.execPath, args, env, join(directory, 'jest.log')); }
  finally {
    if (mode !== 'unit') {
      inspect(JSON.parse(fs.readFileSync(join(directory, 'resource.json'), 'utf8')), env);
      const pool = new Pool({ connectionString: env.TEST_DATABASE_URL, ssl: false });
      try {
        await assertTestDatabase(pool, env.TEST_DATABASE_URL);
        const { rows } = await pool.query('SELECT datname AS database FROM pg_database WHERE NOT datistemplate ORDER BY datname');
        fs.writeFileSync(join(directory, 'retained-databases.json'), JSON.stringify(rows, null, 2));
      } finally { await pool.end(); }
    }
    checkpoint('after-' + mode + '-' + randomUUID()); console.log(`Evidence: ${directory}`);
  }
  const report = JSON.parse(fs.readFileSync(join(directory, 'jest.json'), 'utf8'));
  if (!report.success || report.numPendingTests) throw Error('Incomplete test receipt');
  if (mode === 'all' && !report.testResults.some(result => result.name.endsWith('client-followup-tasks.http.spec.ts') && result.status === 'passed' && result.assertionResults.length > 0 && result.assertionResults.every(test => test.status === 'passed'))) throw Error('Full suite did not execute HTTP coverage');
  console.log(`${mode}: PASS ${report.numPassedTestSuites} suites / ${report.numPassedTests} tests; pending ${report.numPendingTests}`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
