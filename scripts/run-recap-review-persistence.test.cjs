const assert = require('node:assert/strict');
const fs = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');
const { assertOwned, environment, validateProfile } = require('./run-recap-review-persistence.cjs');
const { validateSelection } = require('./run-adherence-integration.cjs');
const { validateReport } = require('./run-integration.cjs');
const owned = { id: 'a'.repeat(64), name: 'exom-test-nonce', imageId: 'sha256:' + 'b'.repeat(64), port: '54321' };
const identity = () => ({
  Id: owned.id, Name: '/' + owned.name, Image: owned.imageId, State: { Running: true },
  Config: { Labels: { 'exom.scope': owned.name }, Env: ['PGDATA=/var/lib/postgresql/exom-ci-data'] },
  HostConfig: { Binds: [], Tmpfs: { '/var/lib/postgresql/exom-ci-data': 'rw', '/var/lib/postgresql/data': 'rw' } },
  Mounts: [{ Type: 'tmpfs' }], NetworkSettings: { Ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: owned.port }] } },
});
assertOwned(identity(), { ...owned });
assertOwned({ ...identity(), Mounts: [] }, { ...owned }); // Docker reports tmpfs in HostConfig, not necessarily Mounts.
assert.throws(() => assertOwned({ ...identity(), Image: 'sha256:' + 'c'.repeat(64) }, { ...owned }), /identity mismatch/);
for (const change of [{ imageId: 'postgres:17-bookworm' }, { imageId: undefined }, { name: 'foreign-owner' }, { id: 'short' }, { port: '55493' }]) assert.throws(() => assertOwned(identity(), { ...owned, ...change }), /identity mismatch/);
for (const change of [{ Image: undefined }, { Mounts: [{ Type: 'volume' }] }, { State: { Running: false } }, { HostConfig: { Binds: ['/foreign:/data'] } }]) assert.throws(() => assertOwned({ ...identity(), ...change }, { ...owned }), /identity mismatch/);
const blocked = identity(); blocked.NetworkSettings.Ports['5432/tcp'][0].HostPort = '55493';
assert.throws(() => assertOwned(blocked, { ...owned, port: undefined }), /identity mismatch/);
const directory = fs.mkdtempSync(join(tmpdir(), 'exom-recap-self-check-'));
const env = environment(directory, { PATH: 'safe-path', DATABASE_URL: 'foreign-secret', FIREBASE_PRIVATE_KEY: 'foreign-secret', NODE_OPTIONS: 'foreign-secret', SMTP_PASSWORD: 'foreign-secret' });
assert.equal(env.PATH, 'safe-path');
assert.doesNotMatch(JSON.stringify(env), /foreign-secret/);
assert.equal(env.HOST, '127.0.0.1');
assert.equal(env.EXOM_SMOKE_DISABLE_SCHEDULERS, '1');
assert.ok(fs.existsSync(join(directory, 'privacy.cjs')) && fs.existsSync(join(directory, 'empty.env')));
fs.writeFileSync(join(directory, '.env'), 'SYNTHETIC_SECRET=not-readable');
const child = spawnSync(process.execPath, ['-e', `const assert = require('node:assert/strict'); assert.equal(require('node:fs').readFileSync(${JSON.stringify(join(directory, '.env'))}, 'utf8'), ''); assert.throws(() => require('node:net').connect({host:'provider.example.invalid', port:443}), /External provider/);`], { env, encoding: 'utf8', shell: false });
assert.equal(child.status, 0, child.stderr);
const report = { success: true, numPassedTests: 224, numPendingTests: 0, numTodoTests: 0, numPendingTestSuites: 0, openHandles: [], testResults: [{ name: 'test/a.spec.ts', status: 'passed', assertionResults: [{ status: 'passed' }] }] };
validateSelection(report, ['test/a.spec.ts']);
assert.doesNotThrow(() => validateProfile(report, 'pg', ['test/a.spec.ts']));
assert.doesNotThrow(() => validateProfile(report, 'adherence-on', ['test/a.spec.ts']));
assert.doesNotThrow(() => validateProfile(report, 'e2e', ['test/a.spec.ts']));
assert.doesNotThrow(() => validateProfile(report, 'concurrency', ['test/a.spec.ts']));
assert.throws(() => validateProfile(report, 'all', ['test/a.spec.ts']), /Required full-suite coverage absent/);
for (const change of [{ numPendingTests: 1 }, { numTodoTests: 1 }, { testResults: [] }, { success: false }, { openHandles: [{}] }]) assert.throws(() => validateSelection({ ...report, ...change }, ['test/a.spec.ts']));
validateReport(report, 'concurrency');
validateReport({ ...report, numPassedTests: 19 }, 'e2e');
assert.throws(() => validateReport({ ...report, numPassedTests: 223 }, 'concurrency'));
assert.throws(() => validateReport({ ...report, numPassedTests: 18 }, 'e2e'));
console.log('Owned image, environment, selection and minimum-count self-checks: PASS; retained ' + directory);
