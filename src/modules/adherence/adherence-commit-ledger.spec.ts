import {
  persistAdherenceCommitEvidence,
  type AdherenceCommitProof,
} from './adherence-commit-ledger';
import type { AdherenceCommitSessionProvider } from './adherence-commit-resolver';

const request = {
  epochId: 'epoch',
  origin: 'synthetic-test-only',
  fullXid: '100',
  cutoffUtc: '2026-10-02T00:00:00.000000Z',
};

const fixture: AdherenceCommitProof = {
  epoch_id: request.epochId,
  origin: request.origin,
  full_xid: request.fullXid,
  digest_version: 1,
  baseline_digest: '1'.repeat(64),
  event_digest: '2'.repeat(64),
  content_digest: '3'.repeat(64),
  proof_digest: '4'.repeat(64),
  event_count: '8',
  activation: false,
  timestamp_utc: '2026-10-01T23:59:59.999999Z',
  microseconds: '1790899199999999',
};
function stored(value: unknown) {
  const query = jest.fn(() => Promise.resolve([value]));
  const provider: AdherenceCommitSessionProvider = {
    withSession: (work) =>
      work({
        sql: { $queryRaw: query },
        verifyOrigin: () => Promise.resolve(request.origin),
      }),
  };
  return { provider, query };
}

describe('immutable commit evidence boundary', () => {
  it('rejects missing origin before any privileged SQL', async () => {
    const query = jest.fn(() => {
      throw new Error('SQL must not run');
    });
    const provider: AdherenceCommitSessionProvider = {
      withSession: (work) =>
        work({
          sql: { $queryRaw: query },
          verifyOrigin: () => Promise.resolve(undefined),
        }),
    };
    expect(await persistAdherenceCommitEvidence(provider, request)).toEqual({
      status: 'unknown',
    });
    expect(query).not.toHaveBeenCalled();
  });
  it('reuses validated proof without querying snapshot/status/timestamp metadata', async () => {
    const { provider, query } = stored({
      value: { state: 'proof', proof: fixture },
      atOrBeforeCutoff: true,
    });
    expect(await persistAdherenceCommitEvidence(provider, request)).toEqual({
      status: 'proof',
      proof: fixture,
      atOrBeforeCutoff: true,
    });
    expect(query).toHaveBeenCalledTimes(1);
  });
  it.each([
    { state: 'invalid' },
    { state: 'proof', proof: { ...fixture, origin: 'other' } },
    { state: 'proof', proof: { ...fixture, full_xid: '101' } },
    { state: 'proof', proof: { ...fixture, epoch_id: 'other' } },
    { state: 'proof', proof: { ...fixture, digest_version: 2 } },
    { state: 'proof', proof: { ...fixture, baseline_digest: '' } },
    { state: 'proof', proof: { ...fixture, event_digest: 'bogus' } },
    { state: 'proof', proof: { ...fixture, content_digest: 'bogus' } },
    { state: 'proof', proof: { ...fixture, proof_digest: 'bogus' } },
    { state: 'proof', proof: { ...fixture, event_count: '0' } },
    { state: 'proof', proof: { ...fixture, timestamp_utc: '2026-10-02' } },
    { state: 'proof', proof: { ...fixture, microseconds: 123 } },
  ])(
    'returns UNKNOWN on invalid persisted binding without reissuance: %j',
    async (value) => {
      const { provider, query } = stored({ value, atOrBeforeCutoff: true });
      expect(await persistAdherenceCommitEvidence(provider, request)).toEqual({
        status: 'unknown',
      });
      expect(query).toHaveBeenCalledTimes(1);
    },
  );
  it('rejects a no-event payload before resolver metadata queries', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ value: { state: 'missing' } }])
      .mockResolvedValueOnce([{ value: null }]);
    const provider: AdherenceCommitSessionProvider = {
      withSession: (work) =>
        work({
          sql: { $queryRaw: query },
          verifyOrigin: () => Promise.resolve(request.origin),
        }),
    };
    expect(await persistAdherenceCommitEvidence(provider, request)).toEqual({
      status: 'unknown',
    });
    expect(query).toHaveBeenCalledTimes(2);
  });
  it('issues using resolver on the same session and validates the resulting proof', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ value: { state: 'missing' } }])
      .mockResolvedValueOnce([
        { value: { content_digest: fixture.content_digest } },
      ])
      .mockResolvedValueOnce([
        { nextFullXid: '110', pid: 7, isolation: 'read committed' },
      ])
      .mockResolvedValueOnce([{ status: 'committed', pid: 7 }])
      .mockResolvedValueOnce([
        {
          timestampUtc: fixture.timestamp_utc,
          microseconds: fixture.microseconds,
          atOrBeforeCutoff: true,
          pid: 7,
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { value: { state: 'proof', proof: fixture }, atOrBeforeCutoff: true },
      ]);
    let sessions = 0;
    const provider: AdherenceCommitSessionProvider = {
      withSession: (work) => {
        sessions++;
        return work({
          sql: { $queryRaw: query },
          verifyOrigin: () => Promise.resolve(request.origin),
        });
      },
    };
    expect(
      (await persistAdherenceCommitEvidence(provider, request)).status,
    ).toBe('proof');
    expect(sessions).toBe(1);
    expect(query).toHaveBeenCalledTimes(7);
  });
});
