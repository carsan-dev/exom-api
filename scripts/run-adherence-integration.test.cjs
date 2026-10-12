const { test } = require('node:test');
const assert = require('node:assert/strict');
const { childEnvironment, prepareOffEnvironment, assertOwnedContainer, assertTracking, validateSelection, checkedChild, legacyPrefix, PG_SUITES, onJestConfig, cleanOwnedCache } = require('./run-adherence-integration.cjs');
const url = 'postgresql://exom_ci:synthetic@127.0.0.1:5432/exom_ci';
test('child aliases are identical and unrelated credentials cannot leak', () => {
  const env = childEnvironment(url, '/owned/empty', { PATH: 'bin', DATABASE_URL: 'production', DIRECT_URL: 'production', SECRET: 'private', EXOM_RESOLVER_TRACKING: 'on' });
  for (const key of ['TEST_DATABASE_URL', 'DATABASE_URL', 'DIRECT_URL', 'PRISMA_DATABASE_URL']) assert.equal(env[key], url);
  assert.equal(env.NODE_ENV, 'test');
  assert.equal(env.SECRET, undefined);
  assert.equal(env.EXOM_RESOLVER_TRACKING, undefined);
  assert.equal(env.DOTENV_CONFIG_PATH, '/owned/empty');
  for (const bad of [url.replace('127.0.0.1', 'remote'), url.replace('5432', '55493'), url + '?host=remote']) assert.throws(() => childEnvironment(bad, '/owned/empty', {}));
});
test('ownership gate rejects changed ID, name, label, port, PGDATA and mounts before cleanup', () => {
  const owned = { id: 'a'.repeat(64), name: 'exom-ci-123', port: '45678' };
  const identity = { Id: owned.id, Name: '/' + owned.name, Config: { Labels: { 'exom.scope': owned.name }, Env: ['PGDATA=/var/lib/postgresql/exom-ci-data'] }, HostConfig: { Tmpfs: { '/var/lib/postgresql/exom-ci-data': 'rw' }, Binds: [] }, Mounts: [], NetworkSettings: { Ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: owned.port }] } } };
  assertOwnedContainer(identity, owned);
  const stopped = structuredClone(identity);
  stopped.NetworkSettings.Ports = {};
  stopped.State = { Running: false };
  stopped.HostConfig.PortBindings = { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }] };
  assertOwnedContainer(stopped, owned, true);
  assert.throws(() => assertOwnedContainer(stopped, owned));
  stopped.HostConfig.PortBindings['5432/tcp'][0].HostIp = '0.0.0.0';
  assert.throws(() => assertOwnedContainer(stopped, owned, true));
  for (const mutate of [i => i.Id = 'b'.repeat(64), i => i.Name = '/other', i => i.Config.Labels['exom.scope'] = 'other', i => i.Config.Env = [], i => i.HostConfig.Tmpfs = {}, i => i.HostConfig.Binds = ['/shared:/data'], i => i.Mounts = [{ Type: 'volume' }], i => i.NetworkSettings.Ports['5432/tcp'][0].HostIp = '0.0.0.0', i => i.NetworkSettings.Ports['5432/tcp'][0].HostPort = '55493']) {
    const copy = structuredClone(identity); mutate(copy); assert.throws(() => assertOwnedContainer(copy, owned));
  }
});
test('tracking must be observed, not inferred from launcher variables', () => {
  assertTracking('off', 'off'); assertTracking('on', 'on');
  assert.throws(() => assertTracking('off', 'on'));
  assert.throws(() => assertTracking('on', undefined));
});
test('suite receipts reject missing, duplicate, skipped and failing suites', () => {
  assert.equal(PG_SUITES.length, 5);
  const inventory = require('node:fs').readdirSync('test').filter(n => n.endsWith('.pg-spec.ts')).map(n => 'test/' + n).sort();
  assert.deepEqual([...PG_SUITES].sort(), inventory);
  const report = { success: true, numPendingTests: 0, numTodoTests: 0, numPendingTestSuites: 0, openHandles: [], testResults: PG_SUITES.map(name => ({ name, status: 'passed', assertionResults: [{ status: 'passed' }] })) };
  validateSelection(report, PG_SUITES);
  for (const change of [{ testResults: report.testResults.slice(1) }, { testResults: [...report.testResults, report.testResults[0]] }, { numPendingTests: 1 }, { numTodoTests: 1 }, { openHandles: [{}] }, { success: false },
    { testResults: report.testResults.map(r => ({ ...r, assertionResults: [{ status: 'pending' }] })) }, { testResults: report.testResults.map(r => ({ ...r, status: 'failed' })) }]) assert.throws(() => validateSelection({ ...report, ...change }, PG_SUITES));
});
test('actual Jest discovery includes all five external suites and the ON resolver', () => {
  const { spawnSync } = require('node:child_process');
  const { resolve } = require('node:path');
  const expected = [...PG_SUITES, 'src/modules/adherence/adherence-commit-resolver.concurrency.spec.ts'];
  const { mkdtempSync, rmdirSync } = require('node:fs');
  const { join } = require('node:path');
  const directory = mkdtempSync(join(require('node:os').tmpdir(), `exom-selection-${require('node:crypto').randomUUID()}-`));
  try {
    const child = spawnSync(process.execPath, [require.resolve('jest/bin/jest'), '--config', JSON.stringify(onJestConfig()), '--cacheDirectory', join(directory, 'cache'), '--listTests', '--json', '--runInBand', '--runTestsByPath', ...expected], {
      encoding: 'utf8', shell: false, env: childEnvironment(url, join(directory, 'empty.env')),
    });
    checkedChild(child);
    const normalize = p => resolve(p).replaceAll('\\', '/');
    assert.deepEqual(JSON.parse(child.stdout).map(normalize).sort(), expected.map(normalize).sort());
  } finally { cleanOwnedCache(directory); rmdirSync(directory); }
});
test('failed or unstarted child aborts the launcher', () => {
  assert.throws(() => checkedChild({ status: 1 }));
  assert.throws(() => checkedChild({ status: null, error: Error('missing executable') }));
  checkedChild({ status: 0 });
});
test('legacy fixture is exactly the committed 84-prefix before baseline', () => {
  const { readdirSync } = require('node:fs');
  const names = readdirSync('prisma/migrations').filter(n => /^\d/.test(n)).sort();
  const prefix = legacyPrefix(names);
  assert.equal(prefix.length, 84);
  assert.equal(names[84], '20261001040000_adherence_history_baseline');
  assert.throws(() => legacyPrefix(names.slice(1)));
});

test('OFF generates required suite flags only after isolated preparation', async () => {
  const env = childEnvironment(url, '/owned/empty', { FOLLOWUP_HTTP_PG: '1', FOLLOWUP_SERVICE_PG: '1', EXOM_RESOLVER_TRACKING: 'on' });
  assert.equal(env.FOLLOWUP_HTTP_PG, undefined);
  assert.equal(env.FOLLOWUP_SERVICE_PG, undefined);
  env.EXOM_RESOLVER_TRACKING = 'off';
  let prepared = false;
  await prepareOffEnvironment(env, async actual => {
    assert.equal(actual, env);
    assert.equal(actual.FOLLOWUP_HTTP_PG, undefined);
    assert.equal(actual.FOLLOWUP_SERVICE_PG, undefined);
    prepared = true;
  });
  assert.equal(prepared, true);
  assert.equal(env.FOLLOWUP_HTTP_PG, '1');
  assert.equal(env.FOLLOWUP_SERVICE_PG, '1');
  assert.equal(env.EXOM_RESOLVER_TRACKING, 'off');
  assert.equal(env.EXOM_LEDGER_OWNED_RUN, undefined);
  assert.equal(PG_SUITES.length, 5);
});
test('failed isolated preparation cannot activate OFF suites', async () => {
  const env = { ...childEnvironment(url, '/owned/empty', {}), EXOM_RESOLVER_TRACKING: 'off' };
  await assert.rejects(prepareOffEnvironment(env, async () => { throw Error('identity or legacy guard failed'); }), /identity or legacy guard failed/);
  assert.equal(env.FOLLOWUP_HTTP_PG, undefined);
  assert.equal(env.FOLLOWUP_SERVICE_PG, undefined);
});
test('ON cannot use OFF suite activation or call its preparation', async () => {
  const env = { ...childEnvironment(url, '/owned/empty', {}), EXOM_RESOLVER_TRACKING: 'on' };
  let called = false;
  await assert.rejects(prepareOffEnvironment(env, async () => { called = true; }), /Unexpected commit timestamp tracking/);
  assert.equal(called, false);
  assert.equal(env.FOLLOWUP_HTTP_PG, undefined);
  assert.equal(env.FOLLOWUP_SERVICE_PG, undefined);
});
