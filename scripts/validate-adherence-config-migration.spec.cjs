const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  assertContainer, assertTarget, assertLegacy, assertRecoveryName,
  assertDatabaseInventory, assertRecoverySchema, cliTarget, deployCli,
} = require('./validate-adherence-config-migration.cjs');

const container = {
  Name: '/exom-p4-t1-ci-20260928',
  Config: { Image: 'postgres:17', Labels: { 'exom.scope': 'p4-t1-20260928' },
    Env: ['POSTGRES_DB=exom_ci', 'POSTGRES_USER=exom_ci',
      'PGDATA=/var/lib/postgresql/exom-ci-data'] },
  State: { Running: true },
  NetworkSettings: { Ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '55493' }] } },
  Mounts: [{ Type: 'volume', Name: 'anonymous', Destination: '/var/lib/postgresql/data' },
    { Type: 'volume', Name: 'exom-p4-t1-ci-20260928-data', Destination: '/var/lib/postgresql/exom-ci-data' }],
};

test('only the identified disposable cluster and inherited local URL are allowed', () => {
  const url = 'postgresql://exom_ci:synthetic@127.0.0.1:55493/exom_ci';
  assert.doesNotThrow(() => assertContainer(container));
  assert.doesNotThrow(() => assertTarget(url, { TEST_DATABASE_URL: url,
    DATABASE_URL: url, PRISMA_DATABASE_URL: url, DIRECT_URL: url }));
  for (const mutation of [
    c => { c.Config.Labels['exom.scope'] = 'other'; },
    c => { c.NetworkSettings.Ports['5432/tcp'][0].HostIp = '0.0.0.0'; },
    c => { c.NetworkSettings.Ports['5432/tcp'][0].HostPort = '55494'; },
    c => { c.Mounts[1].Name = 'other'; },
    c => { c.Config.Env[2] = 'PGDATA=/other'; },
  ]) {
    const other = structuredClone(container); mutation(other);
    assert.throws(() => assertContainer(other));
  }
  assert.throws(() => assertTarget(url, { TEST_DATABASE_URL: url, DATABASE_URL: 'other',
    PRISMA_DATABASE_URL: url, DIRECT_URL: url }));
  assert.throws(() => assertTarget(url.replace('55493', '55494'), {}));
});

test('legacy must have exactly 79 completed migrations and no P4 objects', () => {
  const migrations = Array.from({ length: 79 }, (_, i) => `old-${i}`);
  assert.doesNotThrow(() => assertLegacy(migrations, 0));
  assert.throws(() => assertLegacy(migrations.slice(1), 0));
  assert.throws(() => assertLegacy(migrations, 1));
});

test('retained owned databases are allowed but unrelated databases fail closed', () => {
  const owned = ['exom_ci_p4_t1_source_abcdef123456', 'exom_ci_p4_t1_recovery_abcdef123456',
    'exom_ci_p4_t1_cli_abcdef123456'];
  assert.doesNotThrow(() => assertDatabaseInventory(['exom_ci', 'postgres', 'template0', 'template1', ...owned]));
  for (const name of ['production', 'exom_ci_p4_t1_source_bad', 'exom_ci_p4_t1_recovery_abcdef12345g']) {
    assert.throws(() => assertDatabaseInventory(['exom_ci', 'postgres', 'template0', 'template1', name]));
  }
  assert.throws(() => assertDatabaseInventory(['exom_ci', 'postgres', 'template0', 'template1', owned[0], owned[0]]));
});

test('CLI target accepts only a fresh named clone and never redirects TEST_DATABASE_URL', () => {
  const primary = 'postgresql://exom_ci:synthetic@127.0.0.1:55493/exom_ci';
  const name = 'exom_ci_p4_t1_cli_abcdef123456';
  const target = cliTarget(primary, name, { TEST_DATABASE_URL: primary,
    DATABASE_URL: primary, PRISMA_DATABASE_URL: primary, DIRECT_URL: primary });
  assert.equal(new URL(target.PRISMA_DATABASE_URL).pathname, `/${name}`);
  assert.equal(target.DATABASE_URL, target.PRISMA_DATABASE_URL);
  assert.equal(target.DIRECT_URL, target.PRISMA_DATABASE_URL);
  assert.equal(target.TEST_DATABASE_URL, undefined);
  for (const invalid of ['exom_ci', 'exom_ci_p4_t1_source_abcdef123456',
    'exom_ci_p4_t1_cli_bad', 'exom_ci_p4_t1_cli_abcdef123456/other']) {
    assert.throws(() => cliTarget(primary, invalid, { TEST_DATABASE_URL: primary,
      DATABASE_URL: primary, PRISMA_DATABASE_URL: primary, DIRECT_URL: primary }));
  }
  assert.throws(() => cliTarget(primary, name, { TEST_DATABASE_URL: primary,
    PRISMA_DATABASE_URL: 'postgresql://exom_ci:synthetic@127.0.0.1:55493/postgres',
    DATABASE_URL: primary, DIRECT_URL: primary }));
});

test('CLI path executes migrate deploy with scoped aliases and suppressed output', () => {
  const primary = 'postgresql://exom_ci:synthetic@127.0.0.1:55493/exom_ci';
  const name = 'exom_ci_p4_t1_cli_abcdef123456';
  let invoked = false;
  deployCli(primary, name, { TEST_DATABASE_URL: primary,
    DATABASE_URL: primary, PRISMA_DATABASE_URL: primary, DIRECT_URL: primary },
  (command, args, options) => {
    invoked = true;
    assert.equal(command, process.execPath);
    assert.ok(args[0].endsWith('/node_modules/prisma/build/index.js') ||
      args[0].endsWith('\\node_modules\\prisma\\build\\index.js'));
    assert.deepEqual(args.slice(1, 3), ['migrate', 'deploy']);
    assert.equal(options.env.TEST_DATABASE_URL, undefined);
    for (const alias of ['PRISMA_DATABASE_URL', 'DATABASE_URL', 'DIRECT_URL']) {
      assert.equal(new URL(options.env[alias]).pathname, `/${name}`);
    }
    assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
    return { status: 0, stdout: Buffer.from('secret'), stderr: Buffer.from('secret') };
  });
  assert.ok(invoked, 'actual CLI runner must be invoked');
  assert.throws(() => deployCli(primary, name, { TEST_DATABASE_URL: primary,
    DATABASE_URL: primary, PRISMA_DATABASE_URL: primary, DIRECT_URL: primary },
  () => ({ status: 1, stderr: Buffer.from('secret') })), /Prisma migrate deploy failed/);
});

test('restored schema checks names and SQL behavior, not constraint text formatting', async () => {
  const constraints = [
    'adherence_config_epochs_pkey', 'adherence_config_heads_pkey',
    'adherence_config_heads_version_check', 'adherence_config_revisions_pkey',
    'adherence_config_revisions_steps_goal_check', 'adherence_config_revisions_percent_check',
    'adherence_config_heads_client_id_fkey', 'adherence_config_revisions_client_id_fkey',
  ];
  const indexes = [
    'adherence_config_epochs_pkey', 'adherence_config_heads_pkey',
    'adherence_config_revisions_pkey', 'adherence_config_revisions_client_id_version_key',
    'adherence_config_revisions_client_id_effective_date_key',
    'adherence_config_revisions_client_id_effective_date_idx',
  ];
  function fake(missingConstraint, missingIndex, parentheses) {
    const calls = [];
    const client = {
      query: async (sql, params) => {
        calls.push(sql);
        if (sql === 'BEGIN' || sql === 'ROLLBACK') return {};
        const error = new Error('synthetic SQL rejection');
        error.code = params?.includes('unknown-user') ? '23503'
          : sql.includes('VALUES($1,-1)') || params?.[4] === 0 || params?.[5] === 101 ? '23514' : '23505';
        throw error;
      },
      release() {},
    };
    return { calls, connect: async () => client, query: async sql => {
      calls.push(sql);
      if (sql.includes('pg_constraint')) return { rows: constraints.filter(n => n !== missingConstraint).map(name => ({ name, definition: parentheses ? 'CHECK (((version >= 0)))' : 'CHECK (version >= 0)' })) };
      if (sql.includes('pg_index')) return { rows: indexes.filter(n => n !== missingIndex).map(name => ({ name, valid: true })) };
      throw new Error(`Unexpected catalog query: ${sql}`);
    } };
  }
  const restored = fake(null, null, true);
  await assertRecoverySchema(restored, 'client-id', 'revision-id');
  assert.ok(restored.calls.some(sql => sql.includes('INSERT INTO adherence_config_revisions')));
  await assert.rejects(assertRecoverySchema(fake('adherence_config_heads_version_check', null, false), 'client-id', 'revision-id'));
  await assert.rejects(assertRecoverySchema(fake(null, 'adherence_config_revisions_client_id_effective_date_idx', false), 'client-id', 'revision-id'));
});
