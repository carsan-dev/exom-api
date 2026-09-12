const { spawnSync } = require('node:child_process');
const { mkdtempSync, readFileSync, existsSync, unlinkSync, rmdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { verifyDatabase, databaseUrl } = require('./test-database.cjs');
function validateReport(report, mode) {
  const minimum = mode === 'concurrency' ? 211 : 10;
  if (report.success !== true || report.numPendingTests !== 0 || report.numTodoTests !== 0 ||
      report.numPendingTestSuites !== 0 || report.openHandles?.length ||
      !Number.isInteger(report.numPassedTests) || report.numPassedTests < minimum) {
    throw Error(`Required ${mode} cases did not execute: passed=${report.numPassedTests}, pending=${report.numPendingTests}`);
  }
}
async function main() {
  await verifyDatabase();
  const mode = process.argv[2];
  if (!['concurrency', 'e2e'].includes(mode)) throw Error('Unknown integration suite');
  const directory = mkdtempSync(join(tmpdir(), 'exom-jest-'));
  const result = join(directory, 'result.json');
  try {
    const args = mode === 'e2e' ? ['--config', 'test/jest-e2e.json'] : ['--testPathPatterns=concurrency'];
    const child = spawnSync(process.execPath, [require.resolve('jest/bin/jest'), ...args,
      '--runInBand', '--detectOpenHandles', '--json', '--outputFile', result, ...process.argv.slice(3)], {
      stdio: 'inherit', windowsHide: true,
      env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: databaseUrl(),
        PRISMA_DATABASE_URL: databaseUrl(), DATABASE_SSL_MODE: 'disable' },
    });
    if (child.status !== 0) throw Error(`Jest failed (${child.status ?? child.signal})`);
    const report = JSON.parse(readFileSync(result, 'utf8'));
    validateReport(report, mode);
    console.log(`Required ${mode} cases executed: ${report.numPassedTests}; no skipped tests`);
  } finally { if (existsSync(result)) unlinkSync(result); rmdirSync(directory); }
}
module.exports = { validateReport };
if (require.main === module) {
  let complete = false;
  process.on('beforeExit', () => {
    if (!complete) { console.error('Integration runner did not complete'); process.exitCode = 1; }
  });
  main().then(() => { complete = true; }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
