import {
  resolveAdherenceCommitMetadata,
  type AdherenceCommitSession,
  type AdherenceCommitSessionProvider,
} from './adherence-commit-resolver';

const request = {
  epochId: 'epoch-1',
  fullXid: '4294967303',
  origin: 'operational-origin-1',
  cutoffUtc: '2026-10-02T00:00:00.000001Z',
};

function fixture(origin: string | undefined = request.origin) {
  const query = jest.fn();
  query.mockResolvedValueOnce([
    { nextFullXid: '4294967310', pid: 42, isolation: 'read committed' },
  ]);
  query.mockResolvedValueOnce([{ status: 'committed', pid: 42 }]);
  query.mockResolvedValueOnce([
    {
      timestampUtc: '2026-10-02T00:00:00.000001Z',
      microseconds: '1790899200000001',
      atOrBeforeCutoff: true,
      pid: 42,
    },
  ]);
  const verifyOrigin = jest.fn().mockResolvedValue(origin);
  const session: AdherenceCommitSession = {
    sql: { $queryRaw: query },
    verifyOrigin,
  };
  const provider: AdherenceCommitSessionProvider = {
    withSession: (work) => work(session),
  };
  return { provider, query, verifyOrigin };
}

describe('conditional commit metadata', () => {
  it('retains exact full ID, epoch, origin and microseconds', async () => {
    const f = fixture();
    expect(await resolveAdherenceCommitMetadata(f.provider, request)).toEqual({
      status: 'metadata',
      ...request,
      timestampUtc: '2026-10-02T00:00:00.000001Z',
      microseconds: '1790899200000001',
      atOrBeforeCutoff: true,
    });
    expect(f.query).toHaveBeenCalledTimes(3);
    expect(f.verifyOrigin).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, 'restored-origin'])(
    'rejects origin %s before SQL',
    async (origin) => {
      const f = fixture();
      f.verifyOrigin.mockResolvedValue(origin);
      expect(
        (await resolveAdherenceCommitMetadata(f.provider, request)).status,
      ).toBe('unknown');
      expect(f.query).not.toHaveBeenCalled();
    },
  );

  it.each(['in progress', 'aborted', null])(
    'never looks up timestamps for %s',
    async (status) => {
      const f = fixture();
      f.query
        .mockReset()
        .mockResolvedValueOnce([
          { nextFullXid: '4294967310', pid: 42, isolation: 'read committed' },
        ])
        .mockResolvedValueOnce([{ status, pid: 42 }]);
      expect(
        (await resolveAdherenceCommitMetadata(f.provider, request)).status,
      ).toBe('unknown');
      expect(f.query).toHaveBeenCalledTimes(2);
    },
  );

  it.each(['4294967296', '4294967310', '7', '9007199254740993', '01'])(
    'rejects unsafe ID %s',
    async (fullXid) => {
      const f = fixture();
      expect(
        (
          await resolveAdherenceCommitMetadata(f.provider, {
            ...request,
            fullXid,
          })
        ).status,
      ).toBe('unknown');
      expect(f.query).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['timestamp', 'status', 'snapshot'])(
    'fails closed on %s errors',
    async (stage) => {
      const f = fixture();
      const index = ['snapshot', 'status', 'timestamp'].indexOf(stage);
      f.query.mockReset();
      const rows = [
        [{ nextFullXid: '4294967310', pid: 42, isolation: 'read committed' }],
        [{ status: 'committed', pid: 42 }],
      ];
      for (let i = 0; i < index; i++) f.query.mockResolvedValueOnce(rows[i]);
      f.query.mockRejectedValueOnce(new Error('metadata unavailable'));
      expect(
        (await resolveAdherenceCommitMetadata(f.provider, request)).status,
      ).toBe('unknown');
    },
  );

  it('rejects origin changes during lookup', async () => {
    const f = fixture();
    f.verifyOrigin
      .mockResolvedValueOnce(request.origin)
      .mockResolvedValueOnce('recovered');
    expect(
      (await resolveAdherenceCommitMetadata(f.provider, request)).status,
    ).toBe('unknown');
  });

  it.each([
    { timestampUtc: null, microseconds: null, atOrBeforeCutoff: null, pid: 42 },
    {
      timestampUtc: '2026-10-02T00:00:00.000001Z',
      microseconds: '1790899200000001',
      atOrBeforeCutoff: true,
      pid: 43,
    },
  ])('rejects missing metadata or changed connection', async (row) => {
    const f = fixture();
    f.query
      .mockReset()
      .mockResolvedValueOnce([
        { nextFullXid: '4294967310', pid: 42, isolation: 'read committed' },
      ])
      .mockResolvedValueOnce([{ status: 'committed', pid: 42 }])
      .mockResolvedValueOnce([row]);
    expect(
      (await resolveAdherenceCommitMetadata(f.provider, request)).status,
    ).toBe('unknown');
  });

  it('preserves eligible full64 precision and narrows only the timestamp argument', async () => {
    const f = fixture();
    const fullXid = '9007199254740999';
    f.query
      .mockReset()
      .mockResolvedValueOnce([
        {
          nextFullXid: '9007199254741010',
          pid: 42,
          isolation: 'read committed',
        },
      ])
      .mockResolvedValueOnce([{ status: 'committed', pid: 42 }])
      .mockResolvedValueOnce([
        {
          timestampUtc: request.cutoffUtc,
          microseconds: '1790899200000001',
          atOrBeforeCutoff: true,
          pid: 42,
        },
      ]);
    expect(
      (
        await resolveAdherenceCommitMetadata(f.provider, {
          ...request,
          fullXid,
        })
      ).status,
    ).toBe('metadata');
    expect(f.query.mock.calls).toMatchObject({
      1: { 1: fullXid },
      2: { 1: '7' },
    });
  });

  it.each(['', '2026-10-02T00:00:00Z', '2026-10-02T00:00:00.000001+00:00'])(
    'rejects noncanonical cutoff %s',
    async (cutoffUtc) => {
      const f = fixture();
      expect(
        (
          await resolveAdherenceCommitMetadata(f.provider, {
            ...request,
            cutoffUtc,
          })
        ).status,
      ).toBe('unknown');
      expect(f.query).not.toHaveBeenCalled();
    },
  );

  it('rejects a connection replacement at status lookup', async () => {
    const f = fixture();
    f.query
      .mockReset()
      .mockResolvedValueOnce([
        { nextFullXid: '4294967310', pid: 42, isolation: 'read committed' },
      ])
      .mockResolvedValueOnce([{ status: 'committed', pid: 43 }]);
    expect(
      (await resolveAdherenceCommitMetadata(f.provider, request)).status,
    ).toBe('unknown');
    expect(f.query).toHaveBeenCalledTimes(2);
  });

  it('rejects stale transaction isolation', async () => {
    const f = fixture();
    f.query
      .mockReset()
      .mockResolvedValueOnce([
        { nextFullXid: '4294967310', pid: 42, isolation: 'repeatable read' },
      ]);
    expect(
      (await resolveAdherenceCommitMetadata(f.provider, request)).status,
    ).toBe('unknown');
    expect(f.query).toHaveBeenCalledTimes(1);
  });
});
