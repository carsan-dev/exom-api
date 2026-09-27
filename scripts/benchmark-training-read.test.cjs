'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const benchmark = require('./benchmark-training-read.cjs');

test('inclusive date bounds include leap day and reject a 367th date', () => {
  assert.equal(benchmark.inclusiveDays('2024-01-01', '2024-12-31'), 366);
  assert.throws(() => benchmark.inclusiveDays('2024-01-01', '2025-01-01'), /range/);
  assert.throws(() => benchmark.inclusiveDays('2025-02-29', '2025-03-01'), /range/);
});

test('full-window fixture and same-day distinct exercise fixture retain three sets', () => {
  const full = benchmark.scenario('full_window');
  const heavy = benchmark.scenario('same_day_10k');
  assert.equal(full.days, 366);
  assert.equal(full.entries, 20);
  assert.equal(full.sets, 3);
  assert.equal(heavy.days, 1);
  assert.equal(heavy.entries, 10000);
  assert.equal(heavy.sets, 3);
  assert.equal(new Set(heavy.exerciseIds).size, 10000);
  assert.equal(heavy.dayEntries.length, 10000);
  assert.equal(heavy.dayEntries[9999].sets.length, 3);
});

test('metric summary omits plan content and separates response bytes from plan bytes', () => {
  const plan = { rows: [{ 'QUERY PLAN': [{ 'Planning Time': 1, 'Execution Time': 2,
    Plan: { 'Node Type': 'Seq Scan', 'Actual Rows': 2, 'Actual Loops': 1,
      'Filter': 'client_id = private-id' } }] }] };
  const result = benchmark.summarize('overview_exercises', plan, 5);
  const metric = benchmark.responseMetric('overview_sql_rows_not_http', [{ exercise_id: 'synthetic' }], 7);
  assert.equal(result.wall_ms, 5);
  assert.equal(metric.serialized_response_bytes, Buffer.byteLength(JSON.stringify([{ exercise_id: 'synthetic' }])));
  assert.equal(metric.wall_ms, 7);
  assert.equal(metric.http_response, false);
  assert.ok(!JSON.stringify(result).includes('private-id'));
  assert.ok(!Object.hasOwn(result, 'serialized_response_bytes'));
});

test('preflight-only mode connects to no writer and does not assemble fixtures', async () => {
  let connected = false;
  const pool = {
    query: async (sql) => ({ rows: sql === 'SHOW server_version_num'
      ? [{ server_version_num: '170000' }] : [{ applied: 79, pending: 0 }] }),
    connect: async () => { connected = true; throw Error('write connection'); },
    end: async () => {},
  };
  await benchmark.run({ preflightOnly: true, pool, assertTarget: async () => {} });
  assert.equal(connected, false);
  assert.throws(() => benchmark.parseArgs(['--preflight-only', '--unknown']), /argument/);
});
