const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AsyncLocalStorage } = require('node:async_hooks');
const { instrumentQueries, payloadHash, summarize, endpointMap } = require('./benchmark-dashboard.cjs');
const { compare } = require('./compare.cjs');
const crypto = require('node:crypto');

function comparisonFixture() {
  const rows = Array.from({ length: 200 }, () => {
    const id = crypto.randomUUID();
    return { id, profile: { id: crypto.randomUUID(), user_id: id } };
  });
  const responses = Object.fromEntries(endpointMap('client', '2026-10-11').map(([name]) => [name, { data: { value: 1 } }]));
  responses.selector = { data: { data: rows } };
  responses.profile = { data: { id: rows[0].id, profile: rows[0].profile } };
  responses.day = { data: { diet_history: [{ client_id: rows[0].id, captured_at: '2026-10-11T12:00:01.000Z' }] } };
  const before = structuredClone(responses), after = structuredClone(responses);
  for (const row of after.selector.data.data) row.profile.id = crypto.randomUUID();
  after.profile.data.profile.id = after.selector.data.data[0].profile.id;
  after.day.data.diet_history[0].captured_at = '2026-10-11T12:00:02.000Z';
  return { before, after, windows: [[Date.parse('2026-10-11T12:00:00Z'), Date.parse('2026-10-11T12:00:03Z')], [Date.parse('2026-10-11T12:00:00Z'), Date.parse('2026-10-11T12:00:03Z')]] };
}

test('comparison preserves all fields while mapping only 202 verified synthetic volatile leaves', () => {
  const { before, after, windows } = comparisonFixture();
  assert.equal(compare(before, after, windows).differences.length, 202);
});

test('comparison rejects unrelated mutation, aliases, reordered arrays and invalid capture metadata', () => {
  const mutations = [
    (r) => { r.summary.data.value = 2; },
    (r) => { r.profile.data.profile.extra_id = crypto.randomUUID(); },
    (r) => { delete r.profile.data.profile.user_id; },
    (r) => { r.selector.data.data[1].profile.id = r.selector.data.data[0].profile.id; },
    (r, b) => { r.selector.data.data[1].profile.id = b.selector.data.data[0].profile.id; },
    (r) => { r.selector.data.data.reverse(); },
    (r) => { r.day.data.diet_history[0].captured_at = 'not-a-timestamp'; },
    (r) => { r.day.data.diet_history[0].captured_at = '2026-10-11T12:00:04.000Z'; },
  ];
  for (const mutate of mutations) {
    const { before, after, windows } = comparisonFixture();
    mutate(after, before);
    assert.throws(() => compare(before, after, windows));
  }
});

test('query instrumentation attributes actual promise and callback completions only', async () => {
  class Client {
    query(_sql, callback) {
      if (callback) return setImmediate(() => callback(null, { rowCount: 3 }));
      return Promise.resolve({ rowCount: 2 });
    }
  }
  const storage = new AsyncLocalStorage();
  const undo = instrumentQueries(Client, storage);
  const context = { queries: 0, db_ms: 0, rows: 0, sql: {} };
  try {
    await new Client().query('SELECT unmeasured');
    await storage.run(context, async () => {
      await new Client().query('SELECT promise');
      await new Promise((resolve) => new Client().query('SELECT callback', resolve));
    });
    assert.equal(context.queries, 2);
    assert.equal(context.rows, 5);
    assert.ok(context.db_ms >= 0);
    assert.equal(Object.keys(context.sql).length, 2);
  } finally { undo(); }
});

test('canonical payload comparison preserves every field and array order', () => {
  assert.equal(payloadHash({ a: 1, b: null }), payloadHash({ b: null, a: 1 }));
  assert.notEqual(payloadHash({ a: 1 }), payloadHash({ a: 1, b: null }));
  assert.notEqual(payloadHash([1, 2]), payloadHash([2, 1]));
});

test('summary refuses empty samples or response drift and reports all request families', () => {
  assert.throws(() => summarize([]));
  assert.throws(() => summarize([{ hash: 'a' }, { hash: 'b' }]));
  assert.equal(endpointMap('client', '2026-10-11').length, 11);
});
