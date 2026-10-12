import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  resolveAdherenceCommitMetadata,
  type AdherenceCommitSessionProvider,
} from './adherence-commit-resolver';

// The TEMP launcher guards NEW container identity before setting these aliases.
// Synthetic origin authentication below is fixture-only; no production provider.
describe('PG17 conditional commit metadata', () => {
  let db: PrismaClient;
  const origin = 'exclusive-fixture-origin';
  const request = {
    epochId: 'fixture-epoch',
    origin,
    fullXid: '',
    cutoffUtc: '2099-01-01T00:00:00.000000Z',
  };
  const provider = (
    verified: string | undefined = origin,
  ): AdherenceCommitSessionProvider => ({
    withSession: (work) =>
      db.$transaction(
        async (sql) =>
          work({
            sql,
            verifyOrigin: () => Promise.resolve(verified),
          }),
        { isolationLevel: 'ReadCommitted' },
      ),
  });
  async function xid(): Promise<string> {
    const rows = await db.$queryRaw<
      { xid: string }[]
    >`SELECT pg_current_xact_id()::text AS xid`;
    return rows[0].xid;
  }
  beforeAll(() => {
    if (!process.env.TEST_DATABASE_URL)
      throw new Error('Owned PG fixture required');
    db = new PrismaClient({
      adapter: new PrismaPg({
        connectionString: process.env.TEST_DATABASE_URL,
      }),
    });
  });
  afterAll(async () => {
    await db?.$disconnect();
  });

  it('resolves committed metadata or fails closed with actual tracking off', async () => {
    const fullXid = await xid();
    const result = await resolveAdherenceCommitMetadata(provider(), {
      ...request,
      fullXid,
    });
    if (process.env.EXOM_RESOLVER_TRACKING === 'off') {
      expect(result.status).toBe('unknown');
    } else {
      expect(result.status).toBe('metadata');
      if (result.status === 'metadata') {
        expect(result.microseconds).toMatch(/^\d+$/);
        expect(result.timestampUtc).toMatch(/\.\d{6}Z$/);
      }
    }
  });

  it('does not resolve a held inflight transaction then resolves its commit', async () => {
    let release!: () => void;
    let allocated!: (value: string) => void;
    const ready = new Promise<string>((resolve) => {
      allocated = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writer = db.$transaction(
      async (sql) => {
        const rows = await sql.$queryRaw<
          { xid: string }[]
        >`SELECT pg_current_xact_id()::text AS xid`;
        allocated(rows[0].xid);
        await held;
      },
      { timeout: 15000 },
    );
    try {
      const fullXid = await ready;
      expect(
        (
          await resolveAdherenceCommitMetadata(provider(), {
            ...request,
            fullXid,
          })
        ).status,
      ).toBe('unknown');
      release();
      await writer;
      expect(
        (
          await resolveAdherenceCommitMetadata(provider(), {
            ...request,
            fullXid,
          })
        ).status,
      ).toBe(
        process.env.EXOM_RESOLVER_TRACKING === 'off' ? 'unknown' : 'metadata',
      );
    } finally {
      release();
      await writer;
    }
  });

  it('never resolves an actual rollback', async () => {
    let fullXid = '';
    await expect(
      db.$transaction(async (sql) => {
        const rows = await sql.$queryRaw<
          { xid: string }[]
        >`SELECT pg_current_xact_id()::text AS xid`;
        fullXid = rows[0].xid;
        throw new Error('fixture rollback');
      }),
    ).rejects.toThrow('fixture rollback');
    expect(
      (
        await resolveAdherenceCommitMetadata(provider(), {
          ...request,
          fullXid,
        })
      ).status,
    ).toBe('unknown');
  });

  it('rejects absent/mismatched/recovery origin before SQL', async () => {
    const fullXid = await xid();
    for (const verified of [undefined, 'restored-fixture-origin']) {
      let calls = 0;
      const denied: AdherenceCommitSessionProvider = {
        withSession: (work) =>
          db.$transaction(async (sql) =>
            work({
              sql: {
                $queryRaw: () => {
                  calls++;
                  throw new Error('must not query');
                },
              },
              verifyOrigin: () => {
                void sql;
                return Promise.resolve(verified);
              },
            }),
          ),
      };
      expect(
        (await resolveAdherenceCommitMetadata(denied, { ...request, fullXid }))
          .status,
      ).toBe('unknown');
      expect(calls).toBe(0);
    }
  });

  it('uses real SQL permission denial without granting metadata access', async () => {
    const fullXid = await xid();
    await db.$executeRawUnsafe('CREATE ROLE resolver_denied NOLOGIN');
    // Fixture-only ACL change on a fresh disposable server, never runtime grants.
    await db.$executeRawUnsafe(
      'REVOKE EXECUTE ON FUNCTION pg_catalog.pg_xact_commit_timestamp(xid) FROM PUBLIC',
    );
    try {
      try {
        await db.$transaction(async (sql) => {
          await sql.$executeRawUnsafe('SET LOCAL ROLE resolver_denied');
          await sql.$queryRaw`SELECT pg_xact_commit_timestamp(${fullXid}::xid)`;
        });
        throw new Error('Expected actual SQL permission denial');
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
        if (!(error instanceof Prisma.PrismaClientKnownRequestError))
          throw error;
        expect(error).toMatchObject({
          meta: { driverAdapterError: { cause: { originalCode: '42501' } } },
        });
      }
      const cleanDenied: AdherenceCommitSessionProvider = {
        withSession: (work) =>
          db.$transaction(async (sql) => {
            await sql.$executeRawUnsafe('SET LOCAL ROLE resolver_denied');
            return work({ sql, verifyOrigin: () => Promise.resolve(origin) });
          }),
      };
      expect(
        (
          await resolveAdherenceCommitMetadata(cleanDenied, {
            ...request,
            fullXid,
          })
        ).status,
      ).toBe('unknown');
    } finally {
      await db.$executeRawUnsafe(
        'GRANT EXECUTE ON FUNCTION pg_catalog.pg_xact_commit_timestamp(xid) TO PUBLIC',
      );
      await db.$executeRawUnsafe('DROP ROLE resolver_denied');
    }
  });

  it('rejects actual forgotten initdb status and missing timestamp', async () => {
    const rows = await db.$queryRaw<{ status: string; stamp: string | null }[]>`
      SELECT pg_xact_status('3'::xid8) AS status,
        CASE WHEN current_setting('track_commit_timestamp') = 'on'
          THEN pg_xact_commit_timestamp('3'::xid)::text END AS stamp`;
    expect(rows[0].status).toBeNull();
    expect(rows[0].stamp).toBeNull();
    expect(
      (
        await resolveAdherenceCommitMetadata(provider(), {
          ...request,
          fullXid: '3',
        })
      ).status,
    ).toBe('unknown');
  });

  it('compares actual commit at before/equal/after microsecond cutoffs', async () => {
    const fullXid = await xid();
    const metadata = await resolveAdherenceCommitMetadata(provider(), {
      ...request,
      fullXid,
    });
    if (process.env.EXOM_RESOLVER_TRACKING === 'off') {
      expect(metadata.status).toBe('unknown');
      return;
    }
    expect(metadata.status).toBe('metadata');
    if (metadata.status !== 'metadata')
      throw new Error('Missing actual timestamp');
    const rows = await db.$queryRaw<{ before: string; after: string }[]>`
      SELECT to_char(${metadata.timestampUtc}::timestamptz - interval '1 microsecond',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS before,
        to_char(${metadata.timestampUtc}::timestamptz + interval '1 microsecond',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS after`;
    for (const [cutoffUtc, expected] of [
      [rows[0].before, false],
      [metadata.timestampUtc, true],
      [rows[0].after, true],
    ] as const) {
      const result = await resolveAdherenceCommitMetadata(provider(), {
        ...request,
        fullXid,
        cutoffUtc,
      });
      expect(result.status).toBe('metadata');
      if (result.status === 'metadata')
        expect(result.atOrBeforeCutoff).toBe(expected);
    }
  });
});
