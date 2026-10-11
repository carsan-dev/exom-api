const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AsyncLocalStorage } = require('node:async_hooks');
const { instrumentQueries, payloadHash, summarize, endpointMap } = require('./benchmark-dashboard.cjs');

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
