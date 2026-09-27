const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assertContainer, assertEmptyCluster, prismaEnvironment } = require('./validate-training-session-migration.cjs');

const container = {
  Name: '/exom-training-p3-migration-20260923',
  Config: {
    Image: 'postgres:17',
    Labels: { 'exom.scope': 'p3-migration' },
    Env: ['POSTGRES_DB=exom_ci', 'POSTGRES_USER=exom_ci', 'POSTGRES_PASSWORD=synthetic',
      'PGDATA=/var/lib/postgresql/exom-ci-data'],
  },
  State: { Running: true },
  NetworkSettings: { Ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '55442' }] } },
  Mounts: [{ Type: 'volume', Name: 'anonymous', Destination: '/var/lib/postgresql/data' },
    { Type: 'volume', Name: 'exom-training-p3-migration-20260923-data', Destination: '/var/lib/postgresql/exom-ci-data' }],
};

test('accepts only the exact disposable target and extracts password without exposing it', () => {
  assert.equal(assertContainer(container), 'synthetic');
  for (const change of [
    c => { c.Name = '/other'; },
    c => { c.Config.Image = 'postgres:16'; },
    c => { c.Config.Labels['exom.scope'] = 'other'; },
    c => { c.State.Running = false; },
    c => { c.NetworkSettings.Ports['5432/tcp'][0].HostIp = '0.0.0.0'; },
    c => { c.NetworkSettings.Ports['5432/tcp'][0].HostPort = '55441'; },
    c => { c.Mounts[1].Name = 'unrelated'; },
    c => { c.Config.Env[0] = 'POSTGRES_DB=production'; },
    c => { c.Config.Env[3] = 'PGDATA=/var/lib/postgresql/data'; },
  ]) {
    const altered = structuredClone(container);
    change(altered);
    assert.throws(() => assertContainer(altered), /disposable target/);
  }
});

test('rejects partial migrations, preexisting relations, or another database before writing', () => {
  assert.doesNotThrow(() => assertEmptyCluster(['exom_ci', 'postgres', 'template0', 'template1'], []));
  assert.throws(() => assertEmptyCluster(['exom_ci', 'postgres', 'template0', 'template1'], ['_prisma_migrations']), /nonempty/);
  assert.throws(() => assertEmptyCluster(['exom_ci', 'postgres', 'template0', 'template1', 'somebody_else'], []), /nonempty/);
});

test('every Prisma subprocess overrides ambient production configuration', () => {
  const env = prismaEnvironment('postgresql://exom_ci:synthetic@127.0.0.1:55442/exom_ci', {
    DATABASE_URL: 'production', DIRECT_URL: 'production', TEST_DATABASE_URL: 'production', NODE_ENV: 'production',
  });
  for (const key of ['DATABASE_URL', 'PRISMA_DATABASE_URL', 'TEST_DATABASE_URL', 'DIRECT_URL']) {
    assert.equal(env[key], 'postgresql://exom_ci:synthetic@127.0.0.1:55442/exom_ci');
  }
  assert.equal(env.DATABASE_SSL_MODE, 'disable');
  assert.equal(env.NODE_ENV, 'test');
  assert.throws(() => prismaEnvironment('postgresql://exom_ci:synthetic@127.0.0.1:55441/exom_ci', {}));
});
