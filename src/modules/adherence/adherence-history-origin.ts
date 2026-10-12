import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { Pool } from 'pg';
import type {
  AdherenceCommitRequest,
  AdherenceCommitSession,
  AdherenceCommitSessionProvider,
  AdherenceCommitSql,
} from './adherence-commit-resolver';

/** A dedicated checked-out pg PoolClient satisfies this shape, including nativeClient.
 * Ownership transfers to the factory; callers must not query/release it thereafter.
 */
export interface AdherenceHistoryBackend {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
  on(event: 'error' | 'end', listener: () => void): unknown;
  removeListener(event: 'error' | 'end', listener: () => void): unknown;
  release(destroy?: boolean): void;
}
export interface AdherenceHistoryOrigin extends AdherenceCommitSessionProvider {
  readonly epochId: string;
  readonly activatingFullXid: string;
  readonly origin: string;
  close(): Promise<void>;
}
interface Generation {
  pid: number;
  started: string;
}
interface Activation {
  id: string;
  activating_full_xid: string;
}
class RawPromise<T> extends Promise<T> {
  get [Symbol.toStringTag]() {
    return 'PrismaPromise' as const;
  }
}
const consumed = new WeakSet<AdherenceHistoryBackend>();
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
async function generation(
  client: AdherenceHistoryBackend,
): Promise<Generation> {
  const { rows } = await client.query(`SELECT pg_backend_pid() AS pid,
    backend_start::text AS started FROM pg_catalog.pg_stat_activity
    WHERE pid = pg_backend_pid()`);
  const row = rows[0];
  if (
    rows.length !== 1 ||
    !record(row) ||
    !Number.isInteger(row.pid) ||
    typeof row.started !== 'string'
  )
    throw new Error('Backend generation unavailable');
  return { pid: Number(row.pid), started: row.started };
}

/**
 * Conservative local continuity, NOT global/eternal or malicious-owner protection.
 * Operational prerequisites: trusted owner and NO privileged DDL/restore/maintenance
 * during the lease. IDs diagnose backend replacement; they never mint capabilities.
 * No reconnection, timer, persisted capability, restored-epoch adoption or runtime grants.
 * The authority is this live closure, minted only after positive activation COMMIT ACK.
 * Its random origin label may bind durable proof rows; that label is NOT a bearer
 * capability and cannot reconstruct this closure, its fence or its backend generation.
 */
export async function activateAdherenceHistoryOrigin(
  client: AdherenceHistoryBackend,
): Promise<AdherenceHistoryOrigin> {
  if (consumed.has(client)) throw new Error('Backend already consumed');
  consumed.add(client);
  let revoked = false;
  let released = false;
  const revoke = () => {
    revoked = true;
  };
  client.on('error', revoke);
  client.on('end', revoke);
  const alive = () => {
    if (revoked) throw new Error('Origin lease revoked');
  };
  const release = () => {
    if (!released) {
      released = true;
      // Keep the error listener through destruction; pg may emit asynchronously.
      client.release(true);
    }
  };
  const rollback = async () => {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* Broken transport: destroy. */
    }
  };
  let pinned: Generation;
  let activation: Activation;
  try {
    pinned = await generation(client);
    alive();
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    const { rows } = await client.query(
      'SELECT * FROM public.activate_adherence_history_origin()',
    );
    const row = rows[0];
    if (
      rows.length !== 1 ||
      !record(row) ||
      typeof row.id !== 'string' ||
      typeof row.activating_full_xid !== 'string' ||
      !/^[1-9][0-9]*$/.test(row.activating_full_xid)
    )
      throw new Error('Invalid fresh activation');
    activation = { id: row.id, activating_full_xid: row.activating_full_xid };
    const current = await generation(client);
    alive();
    if (current.pid !== pinned.pid || current.started !== pinned.started)
      throw new Error('Activation backend changed');
    await client.query('COMMIT');
    alive();
  } catch (error) {
    revoke();
    await rollback();
    release();
    throw error;
  }
  const origin = randomUUID();
  let queue: Promise<unknown> = Promise.resolve();
  const check = async () => {
    alive();
    const current = await generation(client);
    alive();
    if (current.pid !== pinned.pid || current.started !== pinned.started) {
      revoke();
      throw new Error('Continuous backend lost');
    }
  };
  const makeSession = () => {
    let active = true;
    const inTransaction = () => {
      alive();
      if (!active) throw new Error('Origin session already ended');
    };
    const sql: AdherenceCommitSql = {
      $queryRaw<T = unknown>(
        query: TemplateStringsArray | Prisma.Sql,
        ...values: unknown[]
      ) {
        const statement = 'raw' in query ? Prisma.sql(query, ...values) : query;
        const execute = async (): Promise<T> => {
          inTransaction();
          try {
            const result = await client.query(statement.text, statement.values);
            inTransaction();
            // Same caller-selected raw row type contract as Prisma.$queryRaw<T>.
            return result.rows as T;
          } catch (error) {
            revoke();
            throw error;
          }
        };
        return new RawPromise<T>((resolve, reject) => {
          void execute().then(resolve, reject);
        });
      },
    };
    const session: AdherenceCommitSession = {
      sql,
      async verifyOrigin(request: AdherenceCommitRequest) {
        inTransaction();
        await check();
        inTransaction();
        return request.epochId === activation.id &&
          request.origin === origin &&
          /^[1-9][0-9]*$/.test(request.fullXid) &&
          BigInt(request.fullXid) >= BigInt(activation.activating_full_xid) &&
          BigInt(request.fullXid) <= 18446744073709551615n
          ? origin
          : undefined;
      },
    };
    return {
      session,
      end: () => {
        active = false;
      },
    };
  };
  return {
    epochId: activation.id,
    activatingFullXid: activation.activating_full_xid,
    origin,
    withSession<T>(
      work: (value: AdherenceCommitSession) => Promise<T>,
    ): Promise<T> {
      const result = queue.then(async () => {
        alive();
        try {
          await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
          await check();
          const scoped = makeSession();
          let value: T;
          try {
            value = await work(scoped.session);
          } finally {
            scoped.end();
          }
          await check();
          await client.query('COMMIT');
          alive();
          return value;
        } catch (error) {
          revoke();
          await rollback();
          throw error;
        }
      });
      queue = result.catch(() => undefined);
      return result;
    },
    async close() {
      revoke();
      await queue;
      release();
    },
  };
}

/** Usable owner factory: checkout once, then never pool/reconnect inside sessions. */
export async function createAdherenceHistoryOrigin(
  pool: Pool,
): Promise<AdherenceHistoryOrigin> {
  return activateAdherenceHistoryOrigin(await pool.connect());
}
