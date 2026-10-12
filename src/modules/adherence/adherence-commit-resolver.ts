import type { Prisma } from '@prisma/client';
import { prepareAdherenceCommitTimestampLookup } from './adherence-full-xid';

export interface AdherenceCommitRequest {
  epochId: string;
  fullXid: string;
  origin: string;
  cutoffUtc: string;
}

/** Narrow privileged executor; a pinned Prisma transaction satisfies this shape. */
export type AdherenceCommitSql = Pick<Prisma.TransactionClient, '$queryRaw'>;

export interface AdherenceCommitSession {
  sql: AdherenceCommitSql;
  /**
   * Operational trust prerequisite, NOT implemented here. Must authenticate the
   * requested epoch's origin on this very connection, holding a continuity
   * fence/lease throughout withSession. IDs (system/timeline/database) alone
   * are insufficient. Return undefined when continuity cannot be established.
   * Recovery/clone/failover must not authorize unresolved original XIDs without
   * independent continuity evidence. Verification must never use another pool.
   */
  verifyOrigin(request: AdherenceCommitRequest): Promise<string | undefined>;
}

export interface AdherenceCommitSessionProvider {
  /**
   * Execute on one pinned READ COMMITTED transaction/connection, with no reconnect
   * or session replacement. Origin fence and privileged executor share its
   * lifetime; release only after callback completes. No general runtime grants
   * are implied. No default provider can safely infer this operational trust.
   */
  withSession<T>(
    work: (session: AdherenceCommitSession) => Promise<T>,
  ): Promise<T>;
}

const STATUS = { UNKNOWN: 'unknown', METADATA: 'metadata' } as const;
const REASON = {
  INPUT: 'invalid_request',
  ORIGIN: 'unverified_origin',
  SNAPSHOT: 'unsafe_snapshot',
  XID: 'unsafe_xid',
  STATUS: 'not_committed_or_unavailable',
  TIMESTAMP: 'timestamp_unavailable',
  ERROR: 'metadata_error',
} as const;
type Reason = (typeof REASON)[keyof typeof REASON];
interface UnknownMetadata {
  status: typeof STATUS.UNKNOWN;
  reason: Reason;
}
interface ConditionalMetadata extends AdherenceCommitRequest {
  status: typeof STATUS.METADATA;
  timestampUtc: string;
  microseconds: string;
  atOrBeforeCutoff: boolean;
}
export type AdherenceCommitMetadata = UnknownMetadata | ConditionalMetadata;

interface SnapshotRow {
  nextFullXid: string;
  pid: number;
  isolation: string;
}
interface StatusRow {
  status: string | null;
  pid: number;
}
interface TimestampRow {
  timestampUtc: string | null;
  microseconds: string | null;
  atOrBeforeCutoff: boolean | null;
  pid: number;
}
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
function unknown(reason: Reason): UnknownMetadata {
  return { status: STATUS.UNKNOWN, reason };
}

/** Conditional lookup evidence only: not durable proof, digest or completeness. */
export async function resolveAdherenceCommitMetadata(
  provider: AdherenceCommitSessionProvider,
  request: AdherenceCommitRequest,
): Promise<AdherenceCommitMetadata> {
  if (
    !request.epochId ||
    !request.origin ||
    !UTC_TIMESTAMP.test(request.cutoffUtc)
  ) {
    return unknown(REASON.INPUT);
  }
  try {
    return await provider.withSession(async (session) => {
      if ((await session.verifyOrigin(request)) !== request.origin) {
        return unknown(REASON.ORIGIN);
      }
      // A fresh READ COMMITTED statement snapshot, never journal observed_at or
      // transaction_timestamp(). xmax bounds full IDs but is NOT completeness.
      const snapshots = await session.sql.$queryRaw<SnapshotRow[]>`
        SELECT pg_snapshot_xmax(pg_current_snapshot())::text AS "nextFullXid",
          pg_backend_pid() AS pid,
          current_setting('transaction_isolation') AS isolation`;
      const snapshot = snapshots[0];
      if (
        snapshots.length !== 1 ||
        snapshot.isolation !== 'read committed' ||
        !Number.isInteger(snapshot.pid)
      ) {
        return unknown(REASON.SNAPSHOT);
      }
      const prepared = prepareAdherenceCommitTimestampLookup(
        request.fullXid,
        snapshot.nextFullXid,
      );
      if (prepared.status !== 'eligible') return unknown(REASON.XID);
      const statuses = await session.sql.$queryRaw<StatusRow[]>`
        SELECT pg_xact_status(${prepared.fullXid}::xid8) AS status,
          pg_backend_pid() AS pid`;
      if (
        statuses.length !== 1 ||
        statuses[0].pid !== snapshot.pid ||
        statuses[0].status !== 'committed'
      ) {
        return unknown(REASON.STATUS);
      }
      // PostgreSQL numeric/text keeps all six fractional digits. Comparison is
      // performed in PG, without Date, floating point, or local timezone parsing.
      const timestamps = await session.sql.$queryRaw<TimestampRow[]>`
        WITH metadata AS MATERIALIZED (
          SELECT pg_xact_commit_timestamp(${prepared.xid32Text}::xid) AS stamp
        )
        SELECT to_char(stamp AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "timestampUtc",
          (extract(epoch FROM stamp) * 1000000)::numeric(30,0)::text AS microseconds,
          stamp <= ${request.cutoffUtc}::timestamptz AS "atOrBeforeCutoff",
          pg_backend_pid() AS pid
        FROM metadata`;
      const row = timestamps[0];
      if (
        timestamps.length !== 1 ||
        row.pid !== snapshot.pid ||
        typeof row.timestampUtc !== 'string' ||
        !UTC_TIMESTAMP.test(row.timestampUtc) ||
        typeof row.microseconds !== 'string' ||
        !/^-?\d+$/.test(row.microseconds) ||
        typeof row.atOrBeforeCutoff !== 'boolean'
      ) {
        return unknown(REASON.TIMESTAMP);
      }
      if ((await session.verifyOrigin(request)) !== request.origin) {
        return unknown(REASON.ORIGIN);
      }
      return {
        status: STATUS.METADATA,
        ...request,
        ...{
          timestampUtc: row.timestampUtc,
          microseconds: row.microseconds,
          atOrBeforeCutoff: row.atOrBeforeCutoff,
        },
      };
    });
  } catch {
    // Do not leak database errors, privileged connection details or origin data.
    return unknown(REASON.ERROR);
  }
}
