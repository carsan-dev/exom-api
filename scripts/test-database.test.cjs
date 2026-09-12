const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { databaseUrl, assertTestDatabase } = require('./test-database.cjs');
const { validateReport } = require('./run-integration.cjs');
const previous = process.env.TEST_DATABASE_URL;
afterEach(() => { if (previous === undefined) delete process.env.TEST_DATABASE_URL; else process.env.TEST_DATABASE_URL = previous; });
const valid = 'postgresql://exom_ci:disposable@127.0.0.1:5432/exom_ci';
test('missing integration URL fails without a production fallback', () => {
  delete process.env.TEST_DATABASE_URL;
  assert.throws(databaseUrl);
});
test('rejects remote hosts, wrong databases, roles and URL overrides', () => {
  for (const url of [valid.replace('127.0.0.1','remote.example'),valid.replace('/exom_ci','/production'),valid.replace('exom_ci:','admin:'),valid+'?host=remote.example']) {
    process.env.TEST_DATABASE_URL=url;
    assert.throws(databaseUrl);
  }
});
test('verifies actual cluster directory before fixture writes', async () => {
  process.env.TEST_DATABASE_URL=valid;
  const row={database:'exom_ci',role:'exom_ci',directory:'/var/lib/postgresql/exom-ci-data'};
  await assertTestDatabase({query:async()=>({rows:[row]})});
  await assert.rejects(assertTestDatabase({query:async()=>({rows:[{...row,directory:'/real-data'}]})}));
});
test('integration gate rejects missing, skipped, failed and unclosed cases', () => {
  const validReport = { success: true, numPassedTests: 211, numPendingTests: 0,
    numTodoTests: 0, numPendingTestSuites: 0, openHandles: [] };
  validateReport(validReport, 'concurrency');
  validateReport({ ...validReport, numPassedTests: 10 }, 'e2e');
  for (const change of [{ success: false }, { numPassedTests: 210 },
    { numPassedTests: undefined }, { numPendingTests: 1 }, { numTodoTests: 1 },
    { numPendingTestSuites: 1 }, { openHandles: [{}] }]) {
    assert.throws(() => validateReport({ ...validReport, ...change }, 'concurrency'));
  }
  assert.throws(() => validateReport({ ...validReport, numPassedTests: 9 }, 'e2e'));
});
