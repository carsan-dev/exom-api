'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validate, operate, rawSql, publisher, preflight, runtime } = require('./adherence-history-operator.cjs');
const id = '60309e31-35fb-4ae5-a89f-a7087403e0fa';
const base = { command: 'run', date: '2026-10-03', clients: [id], host: 'localhost', database: 'owned', role: 'owner', trust: true, maxWaitSeconds: 90, maxTransactions: 128, maxStatements: 4096 };
function fixture(extra = {}) {
  const calls = [];
  const lease = { epochId: id, origin: id, close: async () => calls.push('close'), withSession: async (fn) => fn({ sql: {} }) };
  const deps = { preflight: async () => calls.push('preflight'), now: async () => Date.parse('2026-10-03T23:59:59Z'), acquire: async () => { calls.push('acquire'); return {}; }, activate: async () => { calls.push('activate'); return lease; }, clock: async () => Date.parse('2026-10-04T00:00:00Z'), sleep: async () => {}, cut: async () => ({ status: 'cut' }), validateCut: async () => ({ status: 'cut' }), publish: async (client, date, binding) => { calls.push([client, date, binding]); return { status: 'stored' }; }, end: async () => calls.push('end'), ...extra };
  return { calls, deps };
}
test('safe gates reject missing target, URL, trust, malformed scope and budgets', () => {
  for (const change of [{ host: '' }, { role: '' }, { database: '' }, { trust: false }, { clients: [id, id] }, { clients: ['bad'] }, { clients: Array(101).fill(id) }, { date: '2026-02-30' }, { maxWaitSeconds: 301 }, { maxTransactions: 129 }, { maxStatements: 6 }]) assert.throws(() => validate({ ...base, ...change }, 'postgresql://owner@localhost/owned'));
  assert.throws(() => validate(base, undefined));
  assert.throws(() => validate(base, 'postgresql://other@localhost/owned'));
  assert.equal(validate(base, 'postgresql://owner@localhost/owned').cutoffUtc, '2026-10-04T00:00:00.000000Z');
});
test('preflight never activates and always ends pool', async () => {
  const f = fixture();
  await operate({ ...base, command: 'preflight' }, f.deps);
  assert.deepEqual(f.calls, ['preflight', 'end']);
});
test('closed day and wait overflow reject before activation', async () => {
  for (const now of ['2026-10-04T00:00:00Z', '2026-10-03T12:00:00Z']) {
    const f = fixture({ now: async () => Date.parse(now) });
    assert.equal((await operate(base, f.deps)).status, 'unknown');
    assert.deepEqual(f.calls, ['preflight', 'end']);
  }
});
test('wait pinned lease, then cut and publish exact day/binding, release once', async () => {
  const f = fixture(); const result = await operate(base, f.deps);
  assert.equal(result.status, 'stored');
  assert.equal(result.stored, 1);
  assert.deepEqual(f.calls[3], [id, base.date, { epochId: id, origin: id, cutoffUtc: '2026-10-04T00:00:00.000000Z' }]);
  assert.deepEqual(f.calls.slice(-2), ['close', 'end']);
});
test('abort, disconnect, unknown cut and activation uncertainty never publish', async () => {
  for (const extra of [{ clock: async () => { throw Error('disconnect'); } }, { cut: async () => ({ status: 'unknown' }) }, { activate: async () => { throw Error('commit uncertain'); } }]) {
    const f = fixture(extra); assert.equal((await operate(base, f.deps)).status, 'unknown'); assert.equal(f.calls.some(Array.isArray), false); assert.equal(f.calls.at(-1), 'end');
  }
  const f = fixture(); const signal = AbortSignal.abort();
  assert.equal((await operate(base, f.deps, signal)).status, 'unknown');
  assert.equal(f.calls.includes('activate'), false);
});
test('partial publication counted, conflicts never overwritten, resume never activates', async () => {
  const ids = [id, '70309e31-35fb-4ae5-a89f-a7087403e0fa'];
  let count = 0;
  const f = fixture({ publish: async () => ++count === 1 ? { status: 'stored' } : Promise.reject(Error('conflict')) });
  const result = await operate({ ...base, clients: ids }, f.deps);
  assert.equal(result.status, 'partial'); assert.equal(result.stored, 1); assert.equal(result.unknown, 1);
  const g = fixture();
  assert.equal((await operate({ ...base, command: 'resume', epochId: id, origin: id }, g.deps)).status, 'stored');
  assert.equal(g.calls.includes('activate'), false);
  const h = fixture({ validateCut: async () => ({ status: 'unknown' }) });
  assert.equal((await operate({ ...base, command: 'resume', epochId: id, origin: id }, h.deps)).status, 'unknown');
  assert.equal(h.calls.some(Array.isArray), false);
});
test('uncertain publication commit stops further writes and counts unattempted scope unknown', async () => {
  let attempts = 0;
  const f = fixture({ publish: async () => { attempts++; throw Error('commit uncertain'); } });
  const result = await operate({ ...base, clients: [id, '70309e31-35fb-4ae5-a89f-a7087403e0fa'] }, f.deps);
  assert.equal(attempts, 1); assert.equal(result.unknown, 2); assert.equal(result.status, 'unknown');
});
test('bounded heartbeat waits before cutoff and aborts cleanly', async () => {
  let clocks = 0; let sleeps = 0; let cut = false;
  const f = fixture({ clock: async () => { clocks++; return Date.parse(clocks === 1 ? '2026-10-03T23:59:59.900Z' : '2026-10-04T00:00:00Z'); }, sleep: async () => { sleeps++; }, cut: async () => { assert.equal(clocks, 2); cut = true; return { status: 'cut' }; } });
  assert.equal((await operate(base, f.deps)).status, 'stored'); assert.equal(sleeps, 1); assert.equal(cut, true);
  const controller = new AbortController();
  const g = fixture({ clock: async () => Date.parse('2026-10-03T23:59:59.900Z'), sleep: async () => controller.abort() });
  assert.equal((await operate(base, g.deps, controller.signal)).reasonCode, 'cancelled'); assert.deepEqual(g.calls.slice(-2), ['close', 'end']);
});
test('raw Prisma adapter and independent transaction rollback/release', async () => {
  const calls = []; const client = { query: async (...args) => { calls.push(args); return { rows: [1] }; }, release: () => calls.push('release') };
  const Prisma = { sql: (query, ...values) => ({ text: query.join('$1'), values }) };
  assert.deepEqual(await rawSql(client, Prisma).$queryRaw({ text: 'SELECT $1', values: [2] }), [1]);
  await assert.rejects(publisher({ connect: async () => client }, Prisma).withTransaction(async () => { throw Error('conflict'); }));
  assert.equal(calls.at(-1), 'release'); assert.equal(calls.at(-2)[0], 'ROLLBACK');
});
test('owned PG17 actual owner preflight, pinned factory, early cut and backend loss', { skip: process.env.EXOM_OPERATOR_PG_TEST !== '1' }, async () => {
  const { Pool } = require('pg');
  const url = process.env.ADHERENCE_OWNER_DATABASE_URL;
  const options = validate({ ...base, host: process.env.EXOM_OPERATOR_EXPECTED_HOST, database: process.env.EXOM_OPERATOR_EXPECTED_DATABASE, role: process.env.EXOM_OPERATOR_EXPECTED_ROLE }, url);
  assert.equal(options.host, '127.0.0.1');
  assert.match(options.role, /^nonce60309e31-role-[0-9a-f-]{36}$/);
  const pool = new Pool({ connectionString: url, max: 3 });
  let lease;
  try {
    await preflight(pool, options);
    await assert.rejects(preflight(pool, { ...options, role: 'wrong' }));
    const deps = runtime(pool, options, process.env.EXOM_OPERATOR_TEST_SDK_ROOT);
    lease = await deps.activate(await deps.acquire());
    assert.equal(Number.isFinite(await deps.clock(lease)), true);
    const future = new Date(Date.now() + 86400000).toISOString().slice(0, 10) + 'T00:00:00.000000Z';
    assert.equal((await deps.cut(lease, { cutoffUtc: future, trustedPgUtcClockAndOwner: true, maxTransactions: 128, maxStatements: 4096 })).status, 'unknown');
    await lease.close(); lease = await deps.activate(await deps.acquire());
    const pid = await lease.withSession(async ({ sql }) => (await sql.$queryRaw`SELECT pg_backend_pid() AS pid`)[0].pid);
    await pool.query('SELECT pg_terminate_backend($1)', [pid]);
    await assert.rejects(deps.clock(lease));
  } finally { if (lease) await lease.close(); await pool.end(); }
});
