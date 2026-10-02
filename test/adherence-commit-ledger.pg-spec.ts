import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  persistAdherenceCommitEvidence,
  type AdherenceCommitProof,
} from '../src/modules/adherence/adherence-commit-ledger';
import type {
  AdherenceCommitRequest,
  AdherenceCommitSessionProvider,
} from '../src/modules/adherence/adherence-commit-resolver';

type Payload = Omit<
  AdherenceCommitProof,
  'origin' | 'timestamp_utc' | 'microseconds' | 'proof_digest'
>;
interface ImageRow {
  source_table: string;
  row_key: string;
  row_image: unknown;
}
interface EvidenceEnvelope {
  value: { state: string };
}
interface EventImage {
  operation: string;
}
interface EventRow {
  kind: string;
  image: EventImage;
}

// External origin authority here is explicitly SYNTHETIC, fixture-only.
// Launcher identity-guards a fresh nonce-owned PG17 before assigning aliases.
describe('owner-controlled immutable PG commit evidence', () => {
  let pool: Pool;
  let db: PrismaClient;
  let epochId: string;
  let activationXid: string;
  let fullXid: string;
  let initialImages: unknown[];
  const origin = 'synthetic-ledger-fixture-only';
  const cutoffUtc = '2099-01-01T00:00:00.000000Z';
  const request = (xid = fullXid): AdherenceCommitRequest => ({
    epochId,
    origin,
    fullXid: xid,
    cutoffUtc,
  });
  const provider = (verified = true): AdherenceCommitSessionProvider => ({
    withSession: (work) =>
      db.$transaction(
        (sql) =>
          work({
            sql,
            verifyOrigin: () => Promise.resolve(verified ? origin : undefined),
          }),
        { isolationLevel: 'ReadCommitted', timeout: 20000 },
      ),
  });
  beforeAll(async () => {
    if (!process.env.EXOM_LEDGER_OWNED_RUN)
      throw new Error('Fresh owned ledger launcher required');
    const aliases = [
      'TEST_DATABASE_URL',
      'DATABASE_URL',
      'DIRECT_URL',
      'PRISMA_DATABASE_URL',
    ].map((key) => process.env[key]);
    if (!aliases[0] || !aliases.every((v) => v === aliases[0]))
      throw new Error('Own aliases must match');
    pool = new Pool({ connectionString: aliases[0], max: 8 });
    db = new PrismaClient({
      adapter: new PrismaPg({ connectionString: aliases[0] }),
    });
    const identity = await pool.query(
      `SELECT current_database() db, current_user role,
        current_setting('data_directory') dir, current_setting('track_commit_timestamp') tracking`,
    );
    expect(identity.rows[0]).toEqual({
      db: 'exom_ci',
      role: 'exom_ci',
      dir: '/var/lib/postgresql/exom-ci-data',
      tracking: 'on',
    });
    const epochs = await pool.query<{
      id: string;
      activating_full_xid: string;
    }>('SELECT id,activating_full_xid FROM public.adherence_history_epochs');
    expect(epochs.rowCount).toBe(1);
    epochId = epochs.rows[0].id;
    activationXid = epochs.rows[0].activating_full_xid;
    const sources = [
      'catalog_colors',
      'diet_groups',
      'diets',
      'exercises',
      'ingredients',
      'meal_ingredients',
      'meals',
      'plan_assignment_trainings',
      'plan_assignments',
      'training_blocks',
      'training_exercises',
      'training_groups',
      'trainings',
    ];
    initialImages = (
      await pool.query(
        'SELECT * FROM (' +
          sources
            .map(
              (table) =>
                `SELECT '${table}' source_table,id row_key,to_jsonb(s) row_image FROM public.${table} s`,
            )
            .join(' UNION ALL ') +
          ') images ORDER BY source_table COLLATE "C",row_key COLLATE "C"',
      )
    ).rows;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      fullXid = (
        await client.query<{ xid: string }>(
          'SELECT pg_current_xact_id()::text xid',
        )
      ).rows[0].xid;
      // Multiple entities, both journal kinds, actual source DML, full OLD/NEW.
      await client.query(
        `INSERT INTO training_groups(id,name,normalized_name,updated_at)
          VALUES ('ledger-group-a','Synthetic A','synthetic a',now()),
            ('ledger-group-b','Synthetic B','synthetic b',now());
        UPDATE training_groups SET name=name || ' changed' WHERE id LIKE 'ledger-group-%';
        INSERT INTO plan_assignments(id,client_id,date,updated_at)
          VALUES ('ledger-assignment-a','legacy-client','2098-01-02',now()),
            ('ledger-assignment-b','legacy-client','2098-01-03',now());
        UPDATE plan_assignments SET notes='synthetic changed' WHERE id LIKE 'ledger-assignment-%'`,
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  });
  afterAll(async () => {
    await db?.$disconnect();
    await pool?.end();
  });
  async function payload(xid = fullXid, sql: Pool | PoolClient = pool) {
    return (
      await sql.query<{ value: Payload | null }>(
        'SELECT public.adherence_commit_payload($1,$2) value',
        [epochId, xid],
      )
    ).rows[0].value;
  }
  async function requirePayload(
    xid = fullXid,
    sql: Pool | PoolClient = pool,
  ): Promise<Payload> {
    const result = await payload(xid, sql);
    if (!result) throw new Error('Expected complete fixture payload');
    return result;
  }
  async function metadata(xid: string) {
    return (
      await pool.query<{ stamp: string; micro: string }>(
        `SELECT to_char(pg_xact_commit_timestamp(($1::xid8::text)::xid) AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') stamp,
          (extract(epoch FROM pg_xact_commit_timestamp(($1::xid8::text)::xid))*1000000)::numeric(30,0)::text micro`,
        [xid],
      )
    ).rows[0];
  }
  async function issue(
    sql: Pool | PoolClient,
    xid: string,
    stamp: string,
    micro: string,
    digest: string,
  ) {
    return sql.query(
      'SELECT public.issue_adherence_commit_evidence($1,$2,$3,$4,$5,$6) value',
      [epochId, origin, xid, stamp, micro, digest],
    );
  }
  async function proven(xid = fullXid): Promise<AdherenceCommitProof> {
    const result = await persistAdherenceCommitEvidence(
      provider(),
      request(xid),
    );
    expect(result.status).toBe('proof');
    if (result.status !== 'proof') throw new Error('Missing fixture proof');
    return result.proof;
  }
  it('binds activation with zero events and the complete nonempty legacy baseline', async () => {
    const p = await requirePayload(activationXid);
    expect(p.activation).toBe(true);
    expect(p.event_count).toBe('0');
    const baseline = await pool.query<ImageRow>(
      'SELECT source_table,row_key,row_image FROM public.adherence_history_baselines ORDER BY source_table COLLATE "C",row_key COLLATE "C"',
    );
    expect(baseline.rows).toEqual(initialImages);
    expect(baseline.rows.some((row) => row.row_key === 'legacy-group')).toBe(
      true,
    );
    expect(
      baseline.rows.some((row) => row.row_key === 'legacy-assignment'),
    ).toBe(true);
    const evidence = await proven(activationXid);
    expect(evidence.content_digest).toBe(p.content_digest);
    // Epoch observation is not a proof of precapture source transactions.
    const old = await pool.query<{ transaction_id: string }>(
      `SELECT transaction_id FROM public.adherence_catalog_journal
        WHERE source_table='training_groups' AND new_row->>'id'='legacy-group'`,
    );
    expect(await payload(old.rows[0].transaction_id)).toBeNull();
  });
  it('captures all eight events across BOTH journals, entities, and OLD/NEW fields', async () => {
    const p = await requirePayload();
    expect(p.event_count).toBe('8');
    expect(p.activation).toBe(false);
    const events = await pool.query<EventRow>(
      `SELECT 'assignment' kind,to_jsonb(a) image FROM public.adherence_assignment_journal a WHERE transaction_id=$1
      UNION ALL SELECT 'catalog',to_jsonb(c) FROM public.adherence_catalog_journal c WHERE transaction_id=$1`,
      [fullXid],
    );
    expect(events.rows.filter((e) => e.kind === 'assignment')).toHaveLength(4);
    expect(events.rows.filter((e) => e.kind === 'catalog')).toHaveLength(4);
    expect(
      events.rows.filter((e) => e.image.operation === 'UPDATE'),
    ).toHaveLength(4);
    expect(await proven()).toMatchObject(p);
    expect(await proven()).toEqual(await proven());
  });
  it('refuses a committed nonactivation transaction with no producer events', async () => {
    const xid = (
      await pool.query<{ xid: string }>('SELECT pg_current_xact_id()::text xid')
    ).rows[0].xid;
    expect(await payload(xid)).toBeNull();
    expect(
      await persistAdherenceCommitEvidence(provider(), request(xid)),
    ).toEqual({ status: 'unknown' });
  });
  it('rejects absent authenticated origin and unresolved restored origins', async () => {
    expect(
      await persistAdherenceCommitEvidence(provider(false), request()),
    ).toEqual({ status: 'unknown' });
    const recovery = { ...request(), origin: 'unresolved-restored-origin' };
    expect(await persistAdherenceCommitEvidence(provider(), recovery)).toEqual({
      status: 'unknown',
    });
  });
  it('guards owner UPDATE/DELETE/TRUNCATE and keeps effective ACL private', async () => {
    for (const verb of [
      'UPDATE public.adherence_commit_evidence SET origin=origin',
      'DELETE FROM public.adherence_commit_evidence',
      'TRUNCATE public.adherence_commit_evidence',
    ]) {
      await expect(pool.query(verb)).rejects.toMatchObject({ code: '55000' });
    }
    await pool.query('CREATE ROLE ledger_denied NOLOGIN');
    const client = await pool.connect();
    try {
      for (const sql of [
        'SELECT * FROM public.adherence_commit_evidence',
        'SELECT * FROM public.adherence_history_baselines',
        'SELECT * FROM public.adherence_assignment_journal',
        'SELECT * FROM public.adherence_catalog_journal',
        "SELECT public.adherence_commit_payload('epoch','100')",
      ]) {
        await client.query('BEGIN; SET LOCAL ROLE ledger_denied');
        await expect(client.query(sql)).rejects.toMatchObject({
          code: '42501',
        });
        await client.query('ROLLBACK');
      }
      const funcs = await pool.query<{
        prosecdef: boolean;
        proconfig: string[];
      }>(
        `SELECT p.prosecdef,p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
         WHERE n.nspname='public' AND p.proname IN ('adherence_commit_payload','read_adherence_commit_evidence','issue_adherence_commit_evidence','assert_adherence_commit_owner')`,
      );
      expect(funcs.rowCount).toBe(4);
      for (const f of funcs.rows) {
        expect(f.prosecdef).toBe(false);
        expect(f.proconfig).toContain('search_path=pg_catalog');
      }
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
  it('fails closed if any baseline image or any other-entity journal field changes', async () => {
    const original = await proven();
    for (const table of [
      'adherence_history_baselines',
      'adherence_assignment_journal',
      'adherence_catalog_journal',
    ]) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Explicit trusted-owner tamper simulation, rolled back, never runtime access.
        await client.query(`ALTER TABLE public.${table} DISABLE TRIGGER USER`);
        if (table === 'adherence_history_baselines') {
          await client.query(
            `UPDATE public.${table} SET row_image=row_image || '{"tamper":"fixture"}'::jsonb WHERE epoch_id=$1`,
            [epochId],
          );
        } else {
          await client.query(
            `UPDATE public.${table} SET observed_at=observed_at + interval '1 microsecond' WHERE transaction_id=$1`,
            [fullXid],
          );
        }
        const changed = await requirePayload(fullXid, client);
        expect(changed.content_digest).not.toBe(original.content_digest);
        expect(
          (
            await client.query<EvidenceEnvelope>(
              'SELECT public.read_adherence_commit_evidence($1,$2,$3) value',
              [epochId, origin, fullXid],
            )
          ).rows[0].value.state,
        ).toBe('invalid');
        await expect(
          issue(
            client,
            fullXid,
            original.timestamp_utc,
            original.microseconds,
            original.content_digest,
          ),
        ).rejects.toMatchObject({ code: '22000' });
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    }
    expect(await proven()).toEqual(original);
  });
  it('validates proof origin, exact timestamp and every persisted digest on reads', async () => {
    await proven();
    for (const change of [
      "origin='tampered-origin'",
      "timestamp_utc=to_char(timestamp_utc::timestamptz AT TIME ZONE 'UTC' + interval '1 microsecond','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"'),microseconds=(microseconds::numeric+1)::text",
      "proof_digest=repeat('0',64)",
      "event_digest=repeat('0',64)",
      "baseline_digest=repeat('0',64)",
      "event_count='9'",
      'activation=true',
    ]) {
      const client = await pool.connect();
      try {
        await client.query(
          'BEGIN; ALTER TABLE public.adherence_commit_evidence DISABLE TRIGGER USER',
        );
        await client.query(
          `UPDATE public.adherence_commit_evidence SET ${change} WHERE epoch_id=$1 AND origin=$2 AND full_xid=$3`,
          [epochId, origin, fullXid],
        );
        const targetOrigin = change.startsWith('origin=')
          ? 'tampered-origin'
          : origin;
        const result = await client.query<EvidenceEnvelope>(
          'SELECT public.read_adherence_commit_evidence($1,$2,$3) value',
          [epochId, targetOrigin, fullXid],
        );
        expect(result.rows[0].value.state).toBe('invalid');
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    }
  });
  it('compares reused durable evidence at cutoff minus/equal/plus one microsecond', async () => {
    const p = await proven();
    const edges = (
      await pool.query<{ before: string; after: string }>(
        `SELECT to_char(($1::timestamptz-interval '1 microsecond') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') before,
      to_char(($1::timestamptz+interval '1 microsecond') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') after`,
        [p.timestamp_utc],
      )
    ).rows[0];
    for (const [cutoff, expected] of [
      [edges.before, false],
      [p.timestamp_utc, true],
      [edges.after, true],
    ] as const) {
      const result = await persistAdherenceCommitEvidence(provider(), {
        ...request(),
        cutoffUtc: cutoff,
      });
      expect(result.status).toBe('proof');
      if (result.status === 'proof')
        expect(result.atOrBeforeCutoff).toBe(expected);
    }
  });
  async function contended(conflict: boolean) {
    const writer = await pool.connect();
    const a = await pool.connect();
    const b = await pool.connect();
    let pending: Promise<unknown> | undefined;
    try {
      const id = randomUUID();
      await writer.query('BEGIN');
      const xid = (
        await writer.query<{ xid: string }>(
          'SELECT pg_current_xact_id()::text xid',
        )
      ).rows[0].xid;
      await writer.query(
        "INSERT INTO training_groups(id,name,normalized_name,updated_at) VALUES ($1,'Synthetic concurrency',$1,now())",
        [id],
      );
      await writer.query('COMMIT');
      const binding = await requirePayload(xid);
      const m = await metadata(xid);
      await a.query('BEGIN');
      await issue(a, xid, m.stamp, m.micro, binding.content_digest);
      await b.query('BEGIN');
      const pid = (
        await b.query<{ pid: number }>('SELECT pg_backend_pid() pid')
      ).rows[0].pid;
      const stamp = conflict ? '2098-01-01T00:00:00.000001Z' : m.stamp;
      const micro = conflict ? '4039372800000001' : m.micro;
      // Observe rejection immediately to avoid an unhandled rejection after A commits.
      pending = issue(b, xid, stamp, micro, binding.content_digest).then(
        () => ({ code: 'pass' }),
        (error: unknown) => error,
      );
      let blocked = false;
      for (let i = 0; i < 100; i++) {
        const locks = await pool.query<{ n: number }>(
          'SELECT cardinality(pg_blocking_pids($1)) n',
          [pid],
        );
        if (locks.rows[0].n > 0) {
          blocked = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(blocked).toBe(true);
      await a.query('COMMIT');
      expect(await pending).toMatchObject({
        code: conflict ? '22000' : 'pass',
      });
      await b.query(conflict ? 'ROLLBACK' : 'COMMIT');
      expect(await proven(xid)).toMatchObject({
        timestamp_utc: m.stamp,
        microseconds: m.micro,
      });
    } finally {
      await a.query('ROLLBACK');
      await b.query('ROLLBACK');
      await writer.query('ROLLBACK');
      await pending;
      a.release();
      b.release();
      writer.release();
    }
  }
  it('waits for an actual uncommitted competing issuance then accepts exact replay', async () => {
    await contended(false);
  });
  it('waits for competing issuance then rejects discordant timestamp without overwrite', async () => {
    await contended(true);
  });
  it('rejects digest/timestamp precision conflicts and verifies canonical timezone independence', async () => {
    const p = await proven();
    await expect(
      pool.query(
        'SELECT public.issue_adherence_commit_evidence($1,$2,$3,$4,$5,$6)',
        [
          epochId,
          'discordant-origin',
          fullXid,
          p.timestamp_utc,
          p.microseconds,
          p.content_digest,
        ],
      ),
    ).rejects.toMatchObject({ code: '22000' });
    await expect(
      issue(pool, fullXid, p.timestamp_utc, p.microseconds, '0'.repeat(64)),
    ).rejects.toMatchObject({ code: '22000' });
    await expect(
      issue(
        pool,
        fullXid,
        p.timestamp_utc,
        (BigInt(p.microseconds) + 1n).toString(),
        p.content_digest,
      ),
    ).rejects.toMatchObject({ code: '23514' });
    const client = await pool.connect();
    try {
      await client.query(
        "BEGIN; SET LOCAL TimeZone='Pacific/Auckland'; SET LOCAL DateStyle='SQL, DMY'",
      );
      expect(await payload(fullXid, client)).toEqual(await payload());
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
