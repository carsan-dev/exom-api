import { verifyDatabase } from '../scripts/test-database.cjs';

// All suites verify isolation before any fixture beforeAll runs, even with npm test.
beforeAll(async () => {
  if (process.env.CI === 'true' || process.env.TEST_DATABASE_URL) {
    await verifyDatabase();
  }
});
