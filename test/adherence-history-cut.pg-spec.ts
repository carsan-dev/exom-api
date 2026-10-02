import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { Prisma } from '@prisma/client';
import {
  activateAdherenceHistoryOrigin,
  type AdherenceHistoryOrigin,
} from '../src/modules/adherence/adherence-history-origin';
import {
  materializeAdherenceHistoryCut,
  validateStoredAdherenceHistoryCut,
  type AdherenceHistoryCutManifest,
} from '../src/modules/adherence/adherence-history-cut';
import { persistAdherenceCommitEvidence } from '../src/modules/adherence/adherence-commit-ledger';
import type { AdherenceCommitSql } from '../src/modules/adherence/adherence-commit-resolver';

class RawPromise<T> extends Promise<T> {
  get [Symbol.toStringTag]() {
    return 'PrismaPromise' as const;
  }
}
class Transport extends EventEmitter {
  gate?: Promise<void>;
  waiting = false;
  loseFence = false;
  loseCommitAck = false;
  metadataOff = false;
  metadataNull = false;
  constructor(readonly client: PoolClient) {
    super();
    client.on('error', () => this.emit('error', new Error('Backend lost')));
    client.on('end', () => this.emit('end'));
  }
  async query(text: string, values?: unknown[]) {
    // Explicit alternate metadata-response faults, not server setting changes.
    if (this.metadataOff && text.includes('pg_xact_commit_timestamp'))
      throw new Error('Injected metadata unavailable (tracking off)');
    if (this.metadataNull && text.includes('pg_xact_commit_timestamp'))
      return { rows: [{ timestampUtc: null, microseconds: null }] };
    if (text === 'COMMIT' && this.gate) {
      this.waiting = true;
      await this.gate;
    }
    const result = await this.client.query(text, values);
    if (this.loseFence && text.includes('issue_adherence_history_cut'))
      this.emit('error', new Error('Injected fence loss after INSERT'));
    if (this.loseCommitAck && text === 'COMMIT')
      throw new Error('Injected lost COMMIT ACK');
    return result;
  }
  release(destroy?: boolean) {
    this.client.release(destroy);
  }
}
const stampSql = `to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const options = (cutoffUtc: string) => ({
  cutoffUtc,
  trustedPgUtcClockAndOwner: true,
  maxTransactions: 16,
  maxStatements: 512,
});
function readonlySql(pool: Pool, queries: string[] = []): AdherenceCommitSql {
  return {
    $queryRaw<T = unknown>(
      query: TemplateStringsArray | Prisma.Sql,
      ...values: unknown[]
    ) {
      const statement = 'raw' in query ? Prisma.sql(query, ...values) : query;
      queries.push(statement.text);
      return new RawPromise<T>((resolve, reject) => {
        void pool
          .query(statement.text, statement.values)
          .then((r) => resolve(r.rows as T), reject);
      });
    },
  };
}
async function currentPid(client: PoolClient) {
  return (await client.query<{ pid: number }>('SELECT pg_backend_pid() pid'))
    .rows[0].pid;
}
async function currentXid(client: PoolClient) {
  return (
    await client.query<{ xid: string }>('SELECT pg_current_xact_id()::text xid')
  ).rows[0].xid;
}
// Fresh nonce-owned launcher guard runs before aliases reach Jest. All databases,
// fixtures, binary dumps and containers below belong only to this owned run.
describe('actual complete immutable history cut on PG17', () => {
  let admin: Pool;
  let pool: Pool;
  const dbName = 'cut_' + randomUUID().replaceAll('-', '');
  const leases: AdherenceHistoryOrigin[] = [];
  const artifacts = mkdtempSync(join(tmpdir(), 'exom-cut-pg-'));
  async function activate() {
    const client = await pool.connect();
    const pid = await currentPid(client);
    const transport = new Transport(client);
    const lease = await activateAdherenceHistoryOrigin(transport);
    leases.push(lease);
    return { lease, transport, pid };
  }
  async function clock() {
    return (await pool.query<{ stamp: string }>(`SELECT ${stampSql} stamp`))
      .rows[0].stamp;
  }
  async function key(lease: AdherenceHistoryOrigin, cutoffUtc?: string) {
    return {
      epochId: lease.epochId,
      origin: lease.origin,
      cutoffUtc: cutoffUtc ?? (await clock()),
    };
  }
  async function requireCut(lease: AdherenceHistoryOrigin, cutoffUtc?: string) {
    const result = await materializeAdherenceHistoryCut(
      lease,
      options(cutoffUtc ?? (await clock())),
    );
    expect(result.status).toBe('cut');
    if (result.status !== 'cut') throw new Error('Expected complete manifest');
    return result.manifest;
  }
  async function epochCount(table: string, epochId: string) {
    // Call sites use only two constant test-owned history table names.
    return (
      await pool.query(`SELECT * FROM ${table} WHERE epoch_id=$1`, [epochId])
    ).rowCount;
  }
  async function blocked(waiter: number, blocker: number) {
    for (let i = 0; i < 200; i++) {
      const result = await pool.query<{ yes: boolean }>(
        'SELECT $2::int = ANY(pg_blocking_pids($1::int)) yes',
        [waiter, blocker],
      );
      if (result.rows[0].yes) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Actual blocking PID not observed');
  }
  async function waitFor(check: () => boolean) {
    for (let i = 0; i < 300; i++) {
      if (check()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Gate not observed');
  }
  beforeAll(async () => {
    if (
      !process.env.EXOM_LEDGER_OWNED_RUN ||
      !process.env.EXOM_CUT_OWNED_CONTAINER
    )
      throw new Error('Fresh guarded launcher required');
    admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.pathname = '/' + dbName;
    pool = new Pool({ connectionString: url.toString(), max: 16 });
    const identity = await pool.query(
      `SELECT current_database() db, current_user role,
      current_setting('data_directory') dir, current_setting('track_commit_timestamp') tracking`,
    );
    expect(identity.rows).toEqual([
      {
        db: dbName,
        role: 'exom_ci',
        dir: '/var/lib/postgresql/exom-ci-data',
        tracking: 'on',
      },
    ]);
    const migrationRoot = join(__dirname, '../prisma/migrations');
    const migrations = readdirSync(migrationRoot)
      .filter((name) => /^\d/.test(name))
      .sort();
    expect(migrations).toHaveLength(88);
    for (const name of migrations)
      await pool.query(
        readFileSync(join(migrationRoot, name, 'migration.sql'), 'utf8'),
      );
    await pool.query(`INSERT INTO users(id,email,firebase_uid,updated_at)
      VALUES ('cut-user','cut@example.test','cut-user',now());
      INSERT INTO training_groups(id,name,normalized_name,updated_at)
      VALUES ('cut-group','Synthetic','cut-group',now())`);
  }, 30000);
  afterEach(async () => {
    for (const lease of leases.splice(0)) await lease.close();
  });
  afterAll(async () => {
    for (const lease of leases) await lease.close();
    await pool?.end();
    await admin?.end();
    // Retain fixtures/dumps until identity-guarded whole-container disposal.
    writeFileSync(
      join(artifacts, 'summary.json'),
      JSON.stringify({ dbName, retained: true }),
    );
  });

  it('drains a pre-cut writer and holds all source locks through manifest COMMIT', async () => {
    const { lease, transport, pid } = await activate();
    const writer = await pool.connect();
    const future = await pool.connect();
    let release: () => void = () => undefined;
    transport.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const writerPid = await currentPid(writer);
      const futurePid = await currentPid(future);
      await writer.query('BEGIN');
      const xid = await currentXid(writer);
      await writer.query(
        "UPDATE training_groups SET name='precut observation' WHERE id='cut-group'",
      );
      const cutoffUtc = await clock();
      const cut = materializeAdherenceHistoryCut(lease, options(cutoffUtc));
      await blocked(pid, writerPid);
      await writer.query('COMMIT');
      await waitFor(() => transport.waiting);
      const locks = await pool.query<{ n: number }>(
        `SELECT count(*)::int n FROM pg_locks
        WHERE pid=$1 AND mode='ShareRowExclusiveLock' AND granted`,
        [pid],
      );
      expect(locks.rows[0].n).toBe(13);
      const futureWrite = future.query(
        "UPDATE training_groups SET name='postbarrier' WHERE id='cut-group'",
      );
      await blocked(futurePid, pid);
      release();
      const result = await cut;
      await futureWrite;
      expect(result.status).toBe('cut');
      if (result.status !== 'cut') throw new Error('Expected cut');
      expect(result.manifest.full_xids).toContain(xid);
      const stamps = await pool.query<{ after: boolean; observed: boolean }>(
        `SELECT
        pg_xact_commit_timestamp(($1::xid8::text)::xid) > $2::timestamptz after,
        observed_at <= $2::timestamptz observed FROM adherence_catalog_journal WHERE transaction_id=$1::text`,
        [xid, cutoffUtc],
      );
      expect(stamps.rows).toEqual([{ after: true, observed: true }]);
      expect(
        await validateStoredAdherenceHistoryCut(
          readonlySql(pool),
          await key(lease, cutoffUtc),
        ),
      ).toEqual(result);
    } finally {
      release();
      await writer.query('ROLLBACK');
      writer.release();
      future.release();
    }
  });

  it('rollback is excluded; both journal memberships are complete SQL digests', async () => {
    const { lease } = await activate();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const rolled = await currentXid(client);
      await client.query(
        "UPDATE training_groups SET name='rolled' WHERE id='cut-group'",
      );
      await client.query('ROLLBACK');
      await client.query('BEGIN');
      const xid = await currentXid(client);
      await client.query(`UPDATE training_groups SET name='both' WHERE id='cut-group';
        INSERT INTO plan_assignments(id,client_id,date,updated_at) VALUES
        ('cut-assignment','cut-user','2090-01-01',now())`);
      await client.query('COMMIT');
      const manifest = await requireCut(lease);
      expect(manifest.full_xids).toEqual([lease.activatingFullXid, xid]);
      expect(manifest.full_xids).not.toContain(rolled);
      expect(manifest.assignment_count).toBe('1');
      expect(manifest.catalog_count).toBe('1');
      expect(manifest.proofs).toHaveLength(2);
    } finally {
      client.release();
    }
  });

  it('fresh READ COMMITTED sees a waited writer; stale Repeatable Read does not', async () => {
    const rr = await pool.connect();
    const writer = await pool.connect();
    const rc = await pool.connect();
    try {
      await rr.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await rr.query('SELECT count(*) FROM adherence_catalog_journal');
      await writer.query('BEGIN');
      const xid = await currentXid(writer);
      await writer.query(
        "UPDATE training_groups SET name='fresh visibility' WHERE id='cut-group'",
      );
      const pidRr = await currentPid(rr);
      const pidWriter = await currentPid(writer);
      const lock = rr.query(
        'LOCK TABLE training_groups IN SHARE ROW EXCLUSIVE MODE',
      );
      await blocked(pidRr, pidWriter);
      await writer.query('COMMIT');
      await lock;
      const stale = await rr.query(
        'SELECT * FROM adherence_catalog_journal WHERE transaction_id=$1',
        [xid],
      );
      expect(stale.rowCount).toBe(0);
      await rr.query('ROLLBACK');
      await rc.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await rc.query('LOCK TABLE training_groups IN SHARE ROW EXCLUSIVE MODE');
      const fresh = await rc.query(
        'SELECT * FROM adherence_catalog_journal WHERE transaction_id=$1',
        [xid],
      );
      expect(fresh.rowCount).toBe(1);
      await rc.query('ROLLBACK');
    } finally {
      await rr.query('ROLLBACK');
      await writer.query('ROLLBACK');
      await rc.query('ROLLBACK');
      rr.release();
      writer.release();
      rc.release();
    }
  });

  it.each([-1, 0, 1])(
    'activation cutoff %i microseconds uses exact PG timestamp text',
    async (offset) => {
      const { lease } = await activate();
      const cutoffUtc = (
        await pool.query<{ stamp: string }>(
          `SELECT to_char(
      (pg_xact_commit_timestamp(($1::xid8::text)::xid) + $2 * interval '1 microsecond') AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') stamp`,
          [lease.activatingFullXid, offset],
        )
      ).rows[0].stamp;
      const result = await materializeAdherenceHistoryCut(
        lease,
        options(cutoffUtc),
      );
      expect(result.status).toBe(offset < 0 ? 'unknown' : 'cut');
      if (result.status === 'cut')
        expect(result.manifest.cutoff_utc).toBe(cutoffUtc);
    },
  );

  it.each([
    'untrusted',
    'transactions',
    'statements',
    'metadataOff',
    'metadataNull',
  ] as const)('%s fails closed without a partial manifest', async (failure) => {
    const { lease, transport } = await activate();
    const input = options(await clock());
    if (failure === 'untrusted') input.trustedPgUtcClockAndOwner = false;
    if (failure === 'transactions') {
      input.maxTransactions = 1;
      await pool.query(
        "UPDATE training_groups SET name='budget overflow' WHERE id='cut-group'",
      );
    }
    if (failure === 'statements') input.maxStatements = 8;
    if (failure === 'metadataOff') transport.metadataOff = true;
    if (failure === 'metadataNull') transport.metadataNull = true;
    expect(await materializeAdherenceHistoryCut(lease, input)).toEqual({
      status: 'unknown',
    });
    expect(await epochCount('adherence_history_cuts', lease.epochId)).toBe(0);
    expect(await epochCount('adherence_commit_evidence', lease.epochId)).toBe(
      0,
    );
  });

  it('a future cutoff and an unverified namespace cannot issue any proof', async () => {
    const first = await activate();
    expect(
      await materializeAdherenceHistoryCut(
        first.lease,
        options('2099-01-01T00:00:00.000000Z'),
      ),
    ).toEqual({ status: 'unknown' });
    expect(
      await epochCount('adherence_history_cuts', first.lease.epochId),
    ).toBe(0);
    const second = await activate();
    const wrong: AdherenceHistoryOrigin = {
      ...second.lease,
      origin: 'not-the-live-origin',
    };
    expect(
      await materializeAdherenceHistoryCut(wrong, options(await clock())),
    ).toEqual({ status: 'unknown' });
    expect(
      await epochCount('adherence_commit_evidence', second.lease.epochId),
    ).toBe(0);
  });

  it('source lock timeout aborts instead of committing a partial cut', async () => {
    const { lease, pid } = await activate();
    const writer = await pool.connect();
    try {
      await writer.query('BEGIN');
      await writer.query(
        "UPDATE training_groups SET name='held timeout' WHERE id='cut-group'",
      );
      const pending = materializeAdherenceHistoryCut(
        lease,
        options(await clock()),
      );
      await blocked(pid, await currentPid(writer));
      expect(await pending).toEqual({ status: 'unknown' });
      expect(await epochCount('adherence_history_cuts', lease.epochId)).toBe(0);
      expect(await epochCount('adherence_commit_evidence', lease.epochId)).toBe(
        0,
      );
    } finally {
      await writer.query('ROLLBACK');
      writer.release();
    }
  });

  it('post-INSERT fence loss rolls back manifest and all newly issued proofs', async () => {
    const { lease, transport } = await activate();
    transport.loseFence = true;
    expect(
      await materializeAdherenceHistoryCut(lease, options(await clock())),
    ).toEqual({ status: 'unknown' });
    expect(await epochCount('adherence_history_cuts', lease.epochId)).toBe(0);
    expect(await epochCount('adherence_commit_evidence', lease.epochId)).toBe(
      0,
    );
  });

  it('lost manifest COMMIT acknowledgement is UNKNOWN, with readonly recovery only', async () => {
    const { lease, transport } = await activate();
    const cutoffUtc = await clock();
    transport.loseCommitAck = true;
    expect(
      await materializeAdherenceHistoryCut(lease, options(cutoffUtc)),
    ).toEqual({ status: 'unknown' });
    expect(
      await materializeAdherenceHistoryCut(lease, options(cutoffUtc)),
    ).toEqual({ status: 'unknown' });
    const stored = await validateStoredAdherenceHistoryCut(
      readonlySql(pool),
      await key(lease, cutoffUtc),
    );
    expect(stored.status).toBe('cut');
  });

  it('concurrent exact replay is immutable; a discordant SQL replay is rejected', async () => {
    const { lease } = await activate();
    const cutoffUtc = await clock();
    const [a, b] = await Promise.all([
      materializeAdherenceHistoryCut(lease, options(cutoffUtc)),
      materializeAdherenceHistoryCut(lease, options(cutoffUtc)),
    ]);
    expect(a.status).toBe('cut');
    expect(b).toEqual(a);
    if (a.status !== 'cut') throw new Error('Expected cut');
    const later = (
      await pool.query<{ xid: string }>(
        "UPDATE training_groups SET name='later' WHERE id='cut-group' RETURNING pg_current_xact_id()::text xid",
      )
    ).rows[0].xid;
    expect(
      await materializeAdherenceHistoryCut(lease, options(cutoffUtc)),
    ).toEqual(a);
    const laterProof = await persistAdherenceCommitEvidence(lease, {
      ...(await key(lease, cutoffUtc)),
      fullXid: later,
    });
    expect(laterProof.status).toBe('proof');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const barrier = (
        await client.query<{ value: { barrier_boundary: string } }>(
          'SELECT begin_adherence_history_cut($1,$2,16) value',
          [lease.epochId, cutoffUtc],
        )
      ).rows[0].value;
      await expect(
        client.query(
          'SELECT issue_adherence_history_cut($1,$2,$3,$4::bigint)',
          [lease.epochId, lease.origin, cutoffUtc, barrier.barrier_boundary],
        ),
      ).rejects.toMatchObject({
        code: '22000',
        message: 'Discordant immutable cut retry',
      });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    expect(
      await validateStoredAdherenceHistoryCut(
        readonlySql(pool),
        await key(lease, cutoffUtc),
      ),
    ).toEqual(a);
  });

  it('actual competing SQL cut issuers wait behind the source barrier and accept exact frozen replay', async () => {
    const { lease } = await activate();
    const manifest = await requireCut(lease);
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');
      const pidA = await currentPid(a);
      const pidB = await currentPid(b);
      await a.query('SELECT begin_adherence_history_cut($1,$2,16)', [
        lease.epochId,
        manifest.cutoff_utc,
      ]);
      const waiting = b.query('SELECT begin_adherence_history_cut($1,$2,16)', [
        lease.epochId,
        manifest.cutoff_utc,
      ]);
      await blocked(pidB, pidA);
      const args = [
        lease.epochId,
        lease.origin,
        manifest.cutoff_utc,
        manifest.barrier_boundary,
      ];
      const issuedA = await a.query<{ value: unknown }>(
        'SELECT issue_adherence_history_cut($1,$2,$3,$4::bigint) value',
        args,
      );
      await a.query('COMMIT');
      await waiting;
      const issuedB = await b.query<{ value: unknown }>(
        'SELECT issue_adherence_history_cut($1,$2,$3,$4::bigint) value',
        args,
      );
      expect(issuedB.rows).toEqual(issuedA.rows);
      await b.query('COMMIT');
      expect(await epochCount('adherence_history_cuts', lease.epochId)).toBe(1);
    } finally {
      await a.query('ROLLBACK');
      await b.query('ROLLBACK');
      a.release();
      b.release();
    }
  });

  it('owner append-only protection and private invoker ACL/search_path remain enforced', async () => {
    const { lease } = await activate();
    const manifest = await requireCut(lease);
    for (const sql of [
      "UPDATE adherence_history_cuts SET origin='forged'",
      'DELETE FROM adherence_history_cuts',
      'TRUNCATE adherence_history_cuts',
    ])
      await expect(pool.query(sql)).rejects.toMatchObject({ code: '55000' });
    const meta = await pool.query<{
      secure: boolean;
      config: string[];
      private: boolean;
    }>(`SELECT
      NOT p.prosecdef secure,p.proconfig config,
      NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0) private
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
      AND p.proname IN ('assert_adherence_cut_owner','adherence_cut_universe','begin_adherence_history_cut',
        'adherence_cut_payload','read_adherence_history_cut','issue_adherence_history_cut')`);
    expect(meta.rows).toHaveLength(6);
    for (const row of meta.rows) {
      expect(row.secure).toBe(true);
      expect(row.private).toBe(true);
      expect(row.config).toContain('search_path=pg_catalog');
    }
    const role = 'cut_denied_' + randomUUID().replaceAll('-', '');
    await pool.query(`CREATE ROLE ${role}`);
    const client = await pool.connect();
    try {
      await client.query(`SET ROLE ${role}`);
      await expect(
        client.query('SELECT * FROM adherence_history_cuts'),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        client.query('SELECT read_adherence_history_cut($1,$2,$3)', [
          lease.epochId,
          lease.origin,
          manifest.cutoff_utc,
        ]),
      ).rejects.toMatchObject({ code: '42501' });
      await client.query('RESET ROLE');
    } finally {
      client.release();
    }
  });

  async function tamperRead(
    manifest: AdherenceHistoryCutManifest,
    sql: string,
    values: unknown[] = [],
    database: Pool = pool,
  ) {
    const client = await database.connect();
    try {
      await client.query('BEGIN');
      const [guard, mutation] = sql.split(';');
      await client.query(guard);
      await client.query(mutation, values);
      const result = (
        await client.query<{ value: { state: string } }>(
          'SELECT read_adherence_history_cut($1,$2,$3) value',
          [manifest.epoch_id, manifest.origin, manifest.cutoff_utc],
        )
      ).rows[0].value;
      expect(result.state).toBe('invalid');
      await client.query('ROLLBACK');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }
  it('deleted, added bounded membership, baseline and proof tampering invalidate stored cuts', async () => {
    const { lease } = await activate();
    await pool.query(
      "UPDATE training_groups SET name='tamper fixture' WHERE id='cut-group'",
    );
    const manifest = await requireCut(lease);
    const xid = manifest.full_xids.find(
      (id) => id !== lease.activatingFullXid,
    )!;
    await tamperRead(
      manifest,
      `ALTER TABLE adherence_catalog_journal DISABLE TRIGGER USER;
      DELETE FROM adherence_catalog_journal WHERE transaction_id='${xid}'`,
    );
    await tamperRead(
      manifest,
      `ALTER TABLE adherence_catalog_journal DISABLE TRIGGER USER;
      INSERT INTO adherence_catalog_journal(event_sequence,transaction_id,source_table,operation,old_row,new_row,observed_at)
      SELECT $1::bigint,$2,source_table,operation,old_row,new_row,observed_at
      FROM adherence_catalog_journal WHERE transaction_id=$2 LIMIT 1`,
      [manifest.barrier_boundary, xid],
    );
    await tamperRead(
      manifest,
      `ALTER TABLE adherence_history_baselines DISABLE TRIGGER USER;
      UPDATE adherence_history_baselines SET row_image=row_image || '{"tampered":true}'::jsonb WHERE epoch_id=$1`,
      [lease.epochId],
    );
    await tamperRead(
      manifest,
      `ALTER TABLE adherence_commit_evidence DISABLE TRIGGER USER;
      UPDATE adherence_commit_evidence SET event_digest=repeat('0',64) WHERE epoch_id=$1`,
      [lease.epochId],
    );
    await tamperRead(
      manifest,
      `ALTER TABLE adherence_history_cuts DISABLE TRIGGER USER;
      UPDATE adherence_history_cuts SET manifest=jsonb_set(manifest,'{membership_digest}',to_jsonb(repeat('0',64))) WHERE epoch_id=$1`,
      [lease.epochId],
    );
  });

  it('binary dump/restore preserves original membership/baseline/proofs; readonly uses zero XID metadata queries', async () => {
    const { lease } = await activate();
    await pool.query(
      "UPDATE training_groups SET name='restore payload' WHERE id='cut-group'",
    );
    const manifest = await requireCut(lease);
    await lease.close();
    const container = process.env.EXOM_CUT_OWNED_CONTAINER!;
    const name = process.env.EXOM_CUT_OWNED_NAME!;
    const env = {
      ...process.env,
      MSYS_NO_PATHCONV: '1',
      MSYS2_ARG_CONV_EXCL: '*',
    };
    const identity = execFileSync(
      'docker',
      [
        'inspect',
        '--format',
        '{{.Id}} {{.Name}} {{index .Config.Labels "exom.scope"}} {{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostIp}}',
        container,
      ],
      { env, shell: false, encoding: 'utf8' },
    )
      .trim()
      .split(' ');
    expect(identity).toEqual([container, '/' + name, name, '127.0.0.1']);
    const dump = execFileSync(
      'docker',
      ['exec', container, 'pg_dump', '-U', 'exom_ci', '-d', dbName, '-Fc'],
      { env, shell: false, maxBuffer: 20 * 1024 * 1024 },
    );
    writeFileSync(join(artifacts, 'history.dump'), dump);
    const restoreName = 'restore_' + randomUUID().replaceAll('-', '');
    await admin.query(`CREATE DATABASE ${restoreName}`);
    execFileSync(
      'docker',
      [
        'exec',
        '-i',
        container,
        'pg_restore',
        '-U',
        'exom_ci',
        '-d',
        restoreName,
        '--exit-on-error',
      ],
      { env, shell: false, input: dump, maxBuffer: 20 * 1024 * 1024 },
    );
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.pathname = '/' + restoreName;
    const restored = new Pool({ connectionString: url.toString() });
    try {
      const queries: string[] = [];
      const result = await validateStoredAdherenceHistoryCut(
        readonlySql(restored, queries),
        {
          epochId: lease.epochId,
          origin: lease.origin,
          cutoffUtc: manifest.cutoff_utc,
        },
      );
      expect(result).toEqual({ status: 'cut', manifest });
      expect(queries).toHaveLength(1);
      expect(
        queries.filter((sql) => /pg_xact|pg_current_xact|issue_/i.test(sql)),
      ).toHaveLength(0);
      for (const table of [
        'adherence_history_cuts',
        'adherence_commit_evidence',
        'adherence_history_baselines',
        'adherence_assignment_journal',
        'adherence_catalog_journal',
      ]) {
        const original = await pool.query(
          `SELECT to_jsonb(t) image FROM ${table} t ORDER BY to_jsonb(t)::text COLLATE "C"`,
        );
        const copy = await restored.query(
          `SELECT to_jsonb(t) image FROM ${table} t ORDER BY to_jsonb(t)::text COLLATE "C"`,
        );
        expect(copy.rows).toEqual(original.rows);
      }
      await tamperRead(
        manifest,
        `ALTER TABLE adherence_catalog_journal DISABLE TRIGGER USER;
        DELETE FROM adherence_catalog_journal WHERE event_sequence > $1::bigint AND event_sequence <= $2::bigint`,
        [manifest.epoch_boundary, manifest.barrier_boundary],
        restored,
      );
      await tamperRead(
        manifest,
        `ALTER TABLE adherence_catalog_journal DISABLE TRIGGER USER;
        INSERT INTO adherence_catalog_journal(event_sequence,transaction_id,source_table,operation,old_row,new_row,observed_at)
        SELECT $1::bigint,transaction_id,source_table,operation,old_row,new_row,observed_at
        FROM adherence_catalog_journal WHERE event_sequence > $2::bigint AND event_sequence < $1::bigint LIMIT 1`,
        [manifest.barrier_boundary, manifest.epoch_boundary],
        restored,
      );
      expect(
        await materializeAdherenceHistoryCut(
          lease,
          options(manifest.cutoff_utc),
        ),
      ).toEqual({ status: 'unknown' });
    } finally {
      await restored.end();
    }
  }, 30000);
});
