import type { Prisma } from '@prisma/client';
import type {
  AdherenceCommitSession,
  AdherenceCommitSql,
} from './adherence-commit-resolver';
import { persistAdherenceCommitEvidence } from './adherence-commit-ledger';
import type { AdherenceHistoryOrigin } from './adherence-history-origin';

const STATUS = { UNKNOWN: 'unknown', CUT: 'cut' } as const;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const DIGEST = /^[0-9a-f]{64}$/;
export interface AdherenceHistoryCutKey {
  epochId: string;
  origin: string;
  cutoffUtc: string;
}
export interface AdherenceHistoryCutOptions {
  cutoffUtc: string;
  /** Explicit operating contract, not an arbitrary-clock-jump detector.
   * Trusted PG UTC clock, trusted owner, no privileged DDL/restore/maintenance.
   */
  trustedPgUtcClockAndOwner: boolean;
  maxTransactions: number;
  /** Counts SQL calls AND origin checks; six calls reserved for provider framing.
   * Accepted range7..4096; lower budgets fail before opening a transaction.
   * SQL digest/grouping internal statements are not client round trips.
   */
  maxStatements: number;
}
export interface AdherenceHistoryCutManifest {
  digest_version: number;
  epoch_id: string;
  origin: string;
  cutoff_utc: string;
  cutoff_microseconds: string;
  epoch_boundary: string;
  barrier_boundary: string;
  activation_full_xid: string;
  baseline_digest: string;
  membership_digest: string;
  assignment_count: string;
  catalog_count: string;
  transaction_count: string;
  full_xids: string[];
  proofs: unknown[];
  manifest_digest: string;
}
interface KnownCut {
  status: typeof STATUS.CUT;
  manifest: AdherenceHistoryCutManifest;
}
interface UnknownCut {
  status: typeof STATUS.UNKNOWN;
}
export type AdherenceHistoryCut = KnownCut | UnknownCut;
interface Envelope {
  value: unknown;
}
const unknown = (): UnknownCut => ({ status: STATUS.UNKNOWN });
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function manifest(
  value: unknown,
  key: AdherenceHistoryCutKey,
): value is AdherenceHistoryCutManifest {
  if (!object(value)) return false;
  return (
    Object.keys(value).length === 16 &&
    value.digest_version === 1 &&
    value.epoch_id === key.epochId &&
    value.origin === key.origin &&
    value.cutoff_utc === key.cutoffUtc &&
    typeof value.cutoff_microseconds === 'string' &&
    /^-?(0|[1-9][0-9]*)$/.test(value.cutoff_microseconds) &&
    [
      'epoch_boundary',
      'barrier_boundary',
      'activation_full_xid',
      'assignment_count',
      'catalog_count',
      'transaction_count',
    ].every(
      (field) => typeof value[field] === 'string' && DECIMAL.test(value[field]),
    ) &&
    ['baseline_digest', 'membership_digest', 'manifest_digest'].every(
      (field) => typeof value[field] === 'string' && DIGEST.test(value[field]),
    ) &&
    Array.isArray(value.full_xids) &&
    value.full_xids.length > 0 &&
    value.full_xids.length <= 128 &&
    value.full_xids.every(
      (xid: unknown) => typeof xid === 'string' && /^[1-9][0-9]*$/.test(xid),
    ) &&
    value.transaction_count === String(value.full_xids.length) &&
    Array.isArray(value.proofs) &&
    value.proofs.length === value.full_xids.length
  );
}
function decode(
  rows: Envelope[],
  key: AdherenceHistoryCutKey,
): AdherenceHistoryCut {
  const row = rows[0];
  return rows.length === 1 &&
    object(row.value) &&
    row.value.state === 'cut' &&
    manifest(row.value.manifest, key)
    ? { status: STATUS.CUT, manifest: row.value.manifest }
    : unknown();
}
async function read(sql: AdherenceCommitSql, key: AdherenceHistoryCutKey) {
  return sql.$queryRaw<Envelope[]>`
    SELECT public.read_adherence_history_cut(${key.epochId}, ${key.origin}, ${key.cutoffUtc}) AS value`;
}
function validKey(key: AdherenceHistoryCutKey) {
  return !!key.epochId && !!key.origin && STAMP.test(key.cutoffUtc);
}
/** Restore-safe, read-only original proof/baseline/membership validation.
 * No XID status/timestamp lookup, origin minting or issuance fallback.
 */
export async function validateStoredAdherenceHistoryCut(
  sql: AdherenceCommitSql,
  key: AdherenceHistoryCutKey,
): Promise<AdherenceHistoryCut> {
  if (!validKey(key)) return unknown();
  try {
    return decode(await read(sql, key), key);
  } catch {
    return unknown();
  }
}
/** Owner-only concrete87 provider integration. ALL source locks are held by the
 * provider's single pinned READ COMMITTED transaction THROUGH manifest COMMIT.
 * Every required full transaction (including commits AFTER cutoff) needs proof.
 * No partial cut on missing metadata, overflow or fence failure. Source writers
 * after this barrier commit after cutoff under the acknowledged clock contract.
 */
export async function materializeAdherenceHistoryCut(
  origin: AdherenceHistoryOrigin,
  options: AdherenceHistoryCutOptions,
): Promise<AdherenceHistoryCut> {
  const key = {
    epochId: origin.epochId,
    origin: origin.origin,
    cutoffUtc: options.cutoffUtc,
  };
  if (
    !validKey(key) ||
    options.trustedPgUtcClockAndOwner !== true ||
    !Number.isInteger(options.maxTransactions) ||
    options.maxTransactions < 1 ||
    options.maxTransactions > 128 ||
    !Number.isInteger(options.maxStatements) ||
    options.maxStatements < 7 ||
    options.maxStatements > 4096
  )
    return unknown();
  try {
    return await origin.withSession(async (native) => {
      let statements = 6;
      const consume = () => {
        if (++statements > options.maxStatements)
          throw new Error('Cut statement budget exceeded');
      };
      // Existing86 resolver runs nested through THIS adapter, not a new session.
      const session: AdherenceCommitSession = {
        sql: {
          $queryRaw<T = unknown>(
            query: TemplateStringsArray | Prisma.Sql,
            ...values: unknown[]
          ) {
            consume();
            return native.sql.$queryRaw<T>(query, ...values);
          },
        },
        verifyOrigin(request) {
          consume();
          return native.verifyOrigin(request);
        },
      };
      const activation = { ...key, fullXid: origin.activatingFullXid };
      if ((await session.verifyOrigin(activation)) !== origin.origin)
        return unknown();
      const existing = await read(session.sql, key);
      if (existing.length !== 1 || !object(existing[0].value)) return unknown();
      if (existing[0].value.state === 'cut') {
        if ((await session.verifyOrigin(activation)) !== origin.origin)
          throw new Error('Cut fence lost');
        const stored = decode(existing, key);
        return stored.status === STATUS.CUT &&
          stored.manifest.full_xids.length <= options.maxTransactions
          ? stored
          : unknown();
      }
      if (existing[0].value.state !== 'missing') return unknown();
      const rows = await session.sql.$queryRaw<Envelope[]>`
        SELECT public.begin_adherence_history_cut(${key.epochId}, ${key.cutoffUtc}, ${options.maxTransactions}) AS value`;
      const barrier = rows[0]?.value;
      if (
        rows.length !== 1 ||
        !object(barrier) ||
        typeof barrier.barrier_boundary !== 'string' ||
        !DECIMAL.test(barrier.barrier_boundary) ||
        !Array.isArray(barrier.full_xids) ||
        barrier.full_xids.length < 1 ||
        barrier.full_xids.length > options.maxTransactions ||
        !barrier.full_xids.every(
          (xid: unknown) =>
            typeof xid === 'string' && /^[1-9][0-9]*$/.test(xid),
        )
      )
        throw new Error('Cut barrier/universe unavailable');
      const pinned = {
        withSession: <T>(work: (s: AdherenceCommitSession) => Promise<T>) =>
          work(session),
      };
      for (const fullXid of barrier.full_xids) {
        // The guard above has narrowed every entry; array element inference is unknown.
        if (typeof fullXid !== 'string') throw new Error('Invalid full XID');
        const evidence = await persistAdherenceCommitEvidence(pinned, {
          ...key,
          fullXid,
        });
        if (
          evidence.status !== 'proof' ||
          (fullXid === origin.activatingFullXid && !evidence.atOrBeforeCutoff)
        )
          throw new Error('Required complete commit proof unavailable');
      }
      if ((await session.verifyOrigin(activation)) !== origin.origin)
        throw new Error('Cut fence lost');
      const issued = await session.sql.$queryRaw<Envelope[]>`
        SELECT public.issue_adherence_history_cut(${key.epochId}, ${key.origin}, ${key.cutoffUtc},
          ${barrier.barrier_boundary}::bigint) AS value`;
      const result = decode(issued, key);
      if (
        result.status !== STATUS.CUT ||
        (await session.verifyOrigin(activation)) !== origin.origin
      )
        throw new Error('Cut manifest or fence lost');
      return result;
    });
  } catch {
    // Provider guarantees rollback on callback/fence loss and never remints after
    // uncertain COMMIT; do not misreport an unacknowledged cut as known.
    return unknown();
  }
}
