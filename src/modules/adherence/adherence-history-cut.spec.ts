import {
  materializeAdherenceHistoryCut,
  validateStoredAdherenceHistoryCut,
} from './adherence-history-cut';
import type { AdherenceHistoryOrigin } from './adherence-history-origin';
import type {
  AdherenceCommitSession,
  AdherenceCommitSql,
} from './adherence-commit-resolver';

const cutoffUtc = '2026-10-02T00:00:00.000001Z';
function fixture() {
  const query = jest.fn().mockResolvedValue([{ value: { state: 'missing' } }]);
  const sql = { $queryRaw: query } as unknown as AdherenceCommitSql;
  const verifyOrigin = jest.fn().mockResolvedValue('origin');
  const withSession = jest.fn(
    <T>(work: (s: AdherenceCommitSession) => Promise<T>) =>
      work({ sql, verifyOrigin }),
  );
  const origin: AdherenceHistoryOrigin = {
    epochId: 'epoch',
    activatingFullXid: '100',
    origin: 'origin',
    withSession,
    close: () => Promise.resolve(),
  };
  return { sql, query, verifyOrigin, withSession, origin };
}
const options = {
  cutoffUtc,
  trustedPgUtcClockAndOwner: true,
  maxTransactions: 8,
  maxStatements: 256,
};
describe('complete history cut fails closed', () => {
  it('requires explicit trusted clock/owner acknowledgement before any session', async () => {
    const f = fixture();
    expect(
      await materializeAdherenceHistoryCut(f.origin, {
        ...options,
        trustedPgUtcClockAndOwner: false,
      }),
    ).toEqual({ status: 'unknown' });
    expect(f.withSession).not.toHaveBeenCalled();
  });
  it.each([
    { maxTransactions: 0 },
    { maxTransactions: 129 },
    { maxTransactions: 1.5 },
    { maxStatements: 0 },
    { maxStatements: 6 },
    { maxStatements: 4097 },
    { cutoffUtc: '2026-10-02T00:00:00Z' },
  ])('rejects invalid exact input/budget %p before SQL', async (invalid) => {
    const f = fixture();
    expect(
      await materializeAdherenceHistoryCut(f.origin, {
        ...options,
        ...invalid,
      }),
    ).toEqual({ status: 'unknown' });
    expect(f.withSession).not.toHaveBeenCalled();
  });
  it('does not enumerate or issue on a rejected origin', async () => {
    const f = fixture();
    f.verifyOrigin.mockResolvedValue(undefined);
    expect(await materializeAdherenceHistoryCut(f.origin, options)).toEqual({
      status: 'unknown',
    });
    expect(f.query).not.toHaveBeenCalled();
  });
  it('never reissues an invalid stored manifest', async () => {
    const f = fixture();
    f.query.mockResolvedValue([{ value: { state: 'invalid' } }]);
    expect(await materializeAdherenceHistoryCut(f.origin, options)).toEqual({
      status: 'unknown',
    });
    expect(f.query).toHaveBeenCalledTimes(1);
  });
  it('does not bypass the transaction budget on stored-cut replay', async () => {
    const f = fixture();
    f.query.mockResolvedValue([
      {
        value: {
          state: 'cut',
          manifest: {
            digest_version: 1,
            epoch_id: 'epoch',
            origin: 'origin',
            cutoff_utc: cutoffUtc,
            cutoff_microseconds: '1',
            epoch_boundary: '1',
            barrier_boundary: '2',
            activation_full_xid: '100',
            baseline_digest: 'a'.repeat(64),
            membership_digest: 'b'.repeat(64),
            assignment_count: '0',
            catalog_count: '1',
            transaction_count: '2',
            full_xids: ['100', '101'],
            proofs: [{}, {}],
            manifest_digest: 'c'.repeat(64),
          },
        },
      },
    ]);
    expect(
      await materializeAdherenceHistoryCut(f.origin, {
        ...options,
        maxTransactions: 1,
      }),
    ).toEqual({ status: 'unknown' });
    expect(f.query).toHaveBeenCalledTimes(1);
  });
  it('a session COMMIT failure cannot report a known cut', async () => {
    const f = fixture();
    f.withSession.mockRejectedValue(new Error('Lost COMMIT acknowledgement'));
    expect(await materializeAdherenceHistoryCut(f.origin, options)).toEqual({
      status: 'unknown',
    });
  });
  it('readonly missing evidence performs only the stored validation query', async () => {
    const f = fixture();
    expect(
      await validateStoredAdherenceHistoryCut(f.sql, {
        epochId: 'epoch',
        origin: 'origin',
        cutoffUtc,
      }),
    ).toEqual({ status: 'unknown' });
    expect(f.query).toHaveBeenCalledTimes(1);
    expect(f.verifyOrigin).not.toHaveBeenCalled();
  });
});
