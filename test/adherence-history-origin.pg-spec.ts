import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { Prisma } from '@prisma/client';
import {
  activateAdherenceHistoryOrigin,
  createAdherenceHistoryOrigin,
  type AdherenceHistoryOrigin,
} from '../src/modules/adherence/adherence-history-origin';
import {
  persistAdherenceCommitEvidence,
  validateStoredAdherenceCommitEvidence,
} from '../src/modules/adherence/adherence-commit-ledger';
import type { AdherenceCommitSql } from '../src/modules/adherence/adherence-commit-resolver';

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
const cutoffUtc = '2099-01-01T00:00:00.000000Z';
const request = (lease: AdherenceHistoryOrigin) => ({
  epochId: lease.epochId,
  origin: lease.origin,
  fullXid: lease.activatingFullXid,
  cutoffUtc,
});
async function read<T extends Record<string, unknown>>(
  client: Pool | PoolClient,
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  return (await client.query<T>(text, values)).rows;
}
async function pid(client: PoolClient): Promise<number> {
  return (await read<{ pid: number }>(client, 'SELECT pg_backend_pid() pid'))[0]
    .pid;
}
class RawPromise<T> extends Promise<T> {
  get [Symbol.toStringTag]() {
    return 'PrismaPromise' as const;
  }
}

// Explicit transport fault injection, NOT a true PG crash/ACK-loss experiment.
class Transport extends EventEmitter {
  loseFenceAfterIssue = false;
  loseCommitAck = false;
  commitGate?: Promise<void>;
  commitWaiting = false;
  constructor(readonly client: PoolClient) {
    super();
    client.on('error', () => this.emit('error', new Error('native loss')));
    client.on('end', () => this.emit('end'));
  }
  async query(text: string, values?: unknown[]) {
    if (text === 'COMMIT' && this.commitGate) {
      this.commitWaiting = true;
      await this.commitGate;
    }
    const result = await this.client.query(text, values);
    if (
      this.loseFenceAfterIssue &&
      text.includes('issue_adherence_commit_evidence')
    )
      this.emit('error', new Error('simulated fence loss'));
    if (this.loseCommitAck && text === 'COMMIT')
      throw new Error('simulated lost ACK');
    return result;
  }
  release(destroy?: boolean) {
    this.client.release(destroy);
  }
}

describe('actual fresh activation and continuous backend commit fence', () => {
  let pool: Pool;
  let admin: Pool;
  const dbName = 'origin_' + randomUUID().replaceAll('-', '');
  const leases: AdherenceHistoryOrigin[] = [];
  async function activate() {
    const lease = await createAdherenceHistoryOrigin(pool);
    leases.push(lease);
    return lease;
  }
  async function count() {
    return (
      await read<{ n: number }>(
        pool,
        'SELECT count(*)::int n FROM public.adherence_history_epochs',
      )
    )[0].n;
  }
  async function proofCount(epoch: string) {
    return (
      await read<{ n: number }>(
        pool,
        'SELECT count(*)::int n FROM public.adherence_commit_evidence WHERE epoch_id=$1',
        [epoch],
      )
    )[0].n;
  }
  async function blocked(waiter: number, blocker: number) {
    for (let i = 0; i < 200; i++) {
      const result = await read<{ blocked: boolean }>(
        pool,
        'SELECT $2::int = ANY(pg_blocking_pids($1::int)) blocked',
        [waiter, blocker],
      );
      if (result[0].blocked) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Actual PG blocking PID not observed');
  }
  beforeAll(async () => {
    if (!process.env.EXOM_LEDGER_OWNED_RUN)
      throw new Error('Owned fresh launcher required');
    admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.pathname = '/' + dbName;
    pool = new Pool({ connectionString: url.toString(), max: 12 });
    const identity = await read(
      pool,
      `SELECT current_database() db,
      current_user role, current_setting('data_directory') dir,
      current_setting('track_commit_timestamp') tracking`,
    );
    expect(identity).toEqual([
      {
        db: dbName,
        role: 'exom_ci',
        dir: '/var/lib/postgresql/exom-ci-data',
        tracking: 'on',
      },
    ]);
    const migrationRoot = join(__dirname, '../prisma/migrations');
    const migrations = readdirSync(migrationRoot)
      // Preserve the approved87 predecessor fixture, independent of later migrations.
      .filter((name) => /^\d/.test(name) && name < '20261002030000')
      .sort();
    expect(migrations).toHaveLength(87);
    for (const name of migrations)
      await pool.query(
        readFileSync(join(migrationRoot, name, 'migration.sql'), 'utf8'),
      );
    // Every source nonempty; full synthetic untimed/training/diet row payloads.
    for (const statement of [
      "INSERT INTO users(id,email,firebase_uid,updated_at) VALUES ('u','origin@example.test','u',now())",
      "INSERT INTO training_groups(id,name,normalized_name,updated_at) VALUES ('tg','Synthetic','tg',now())",
      "INSERT INTO diet_groups(id,name,normalized_name,updated_at) VALUES ('dg','Synthetic','dg',now())",
      "INSERT INTO catalog_colors(id,catalog_type,normalized_key,value,color,updated_at) VALUES ('cc','training_type','cc','TEST','#abcdef',now())",
      "INSERT INTO trainings(id,name,type,types,tags,group_id,updated_at) VALUES ('t','Synthetic','TEST',ARRAY['TEST'],'{}','tg',now())",
      "INSERT INTO exercises(id,name,muscle_groups,equipment,updated_at) VALUES ('e','Synthetic',ARRAY['TEST'],ARRAY['TEST'],now())",
      `INSERT INTO training_blocks(id,training_id,"order",rounds,updated_at) VALUES ('b','t',0,3,now())`,
      `INSERT INTO training_exercises(id,training_id,exercise_id,block_id,"order",sets,reps_or_duration,measure_type,target_value_min,target_value_max,target_rir,timed_config) VALUES ('te','t','e','b',0,3,'8-12','REPS',8,12,3,NULL)`,
      "INSERT INTO diets(id,name,tags,total_calories,total_protein_g,total_carbs_g,total_fat_g,group_id,updated_at) VALUES ('d','Synthetic','{}',1800,130,200,60,'dg',now())",
      "INSERT INTO meals(id,diet_id,type,name,nutritional_badges,calories,protein_g,carbs_g,fat_g,updated_at) VALUES ('m','d','BREAKFAST','Synthetic','{}',400,30,50,10,now())",
      "INSERT INTO ingredients(id,name,calories_per_100g,protein_per_100g,carbs_per_100g,fat_per_100g,updated_at) VALUES ('i','Synthetic',300,20,40,10,now())",
      "INSERT INTO meal_ingredients(id,meal_id,ingredient_id,quantity,grams_equivalent) VALUES ('mi','m','i',100,95)",
      "INSERT INTO plan_assignments(id,client_id,date,diet_id,updated_at) VALUES ('pa','u','2099-01-01','d',now())",
      "INSERT INTO plan_assignment_trainings(id,assignment_id,training_id,position,last_set_video_policy) VALUES ('pat','pa','t',0,'NEVER')",
    ])
      await pool.query(statement);
  }, 120000);
  afterEach(async () => {
    for (const lease of leases) await lease.close();
    leases.length = 0;
  });
  afterAll(async () => {
    for (const lease of leases) await lease.close();
    await pool?.end();
    await admin?.end();
    // Launcher inventories then disposes whole owned server, not journal rows.
  });

  it('fresh activation snapshots ALL 13 full row sets and keeps previous epochs immutable', async () => {
    const previous = await read<{ id: string }>(
      pool,
      'SELECT * FROM public.adherence_history_epochs',
    );
    const lease = await activate();
    const expected = await read(
      pool,
      'SELECT * FROM (' +
        sources
          .map(
            (source) =>
              `SELECT '${source}' source_table, id row_key, to_jsonb(s) row_image FROM public.${source} s`,
          )
          .join(' UNION ALL ') +
        ') source_images ORDER BY source_table COLLATE "C",row_key COLLATE "C"',
    );
    const images = await read<{ source_table: string }>(
      pool,
      'SELECT source_table,row_key,row_image FROM public.adherence_history_baselines WHERE epoch_id=$1 ORDER BY source_table COLLATE "C",row_key COLLATE "C"',
      [lease.epochId],
    );
    expect(images).toEqual(expected);
    expect(new Set(images.map((row) => row.source_table)).size).toBe(13);
    for (const old of previous)
      expect(
        await read(
          pool,
          'SELECT * FROM public.adherence_history_epochs WHERE id=$1',
          [old.id],
        ),
      ).toEqual([old]);
    const next = await activate();
    expect(next.epochId).not.toBe(lease.epochId);
    expect(next.origin).not.toBe(lease.origin);
    expect(await persistAdherenceCommitEvidence(next, request(lease))).toEqual({
      status: 'unknown',
    });
  });

  it('real writer and competing activation barrier reports actual blocking PIDs', async () => {
    const writer = await pool.connect();
    const first = await pool.connect();
    const second = await pool.connect();
    try {
      const writerPid = await pid(writer);
      const firstPid = await pid(first);
      const secondPid = await pid(second);
      await writer.query('BEGIN');
      await writer.query(
        "UPDATE public.trainings SET name='Writer committed' WHERE id='t'",
      );
      await first.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const waiting = read<{ id: string }>(
        first,
        'SELECT * FROM public.activate_adherence_history_origin()',
      );
      await blocked(firstPid, writerPid);
      await second.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const competing = read<{ id: string }>(
        second,
        'SELECT * FROM public.activate_adherence_history_origin()',
      );
      await blocked(secondPid, firstPid);
      await writer.query('COMMIT');
      const epoch = (await waiting)[0];
      const expected = await read(
        first,
        'SELECT * FROM (' +
          sources
            .map(
              (source) =>
                `SELECT '${source}' source_table,id row_key,to_jsonb(s) row_image FROM public.${source} s`,
            )
            .join(' UNION ALL ') +
          ') images ORDER BY source_table COLLATE "C",row_key COLLATE "C"',
      );
      expect(
        await read(
          first,
          'SELECT source_table,row_key,row_image FROM public.adherence_history_baselines WHERE epoch_id=$1 ORDER BY source_table COLLATE "C",row_key COLLATE "C"',
          [epoch.id],
        ),
      ).toEqual(expected);
      expect(
        await read(
          first,
          "SELECT row_image->>'name' name FROM public.adherence_history_baselines WHERE epoch_id=$1 AND source_table='trainings'",
          [epoch.id],
        ),
      ).toEqual([{ name: 'Writer committed' }]);
      await first.query('COMMIT');
      const other = (await competing)[0];
      await second.query('COMMIT');
      expect(other.id).not.toBe(epoch.id);
    } finally {
      for (const client of [writer, first, second]) {
        await client.query('ROLLBACK');
        client.release();
      }
    }
  });

  it('activation lock timeout rolls back and cannot mint a capability', async () => {
    const initial = await count();
    const writer = await pool.connect();
    try {
      await writer.query('BEGIN');
      await writer.query(
        'LOCK TABLE public.catalog_colors IN ROW EXCLUSIVE MODE',
      );
      await expect(createAdherenceHistoryOrigin(pool)).rejects.toMatchObject({
        code: '55P03',
      });
      expect(await count()).toBe(initial);
    } finally {
      await writer.query('ROLLBACK');
      writer.release();
    }
  }, 15000);

  it('late failure and explicit rollback leave epoch and images unchanged', async () => {
    const initial = await count();
    const images = await read(
      pool,
      'SELECT * FROM public.adherence_history_baselines ORDER BY epoch_id,source_table,row_key',
    );
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `CREATE FUNCTION pg_temp.fail_baseline() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'late failure' USING ERRCODE='22012'; END $$`,
      );
      await client.query(
        `CREATE TRIGGER fixture_failure BEFORE INSERT ON public.adherence_history_baselines FOR EACH ROW WHEN (NEW.source_table='trainings') EXECUTE FUNCTION pg_temp.fail_baseline()`,
      );
      await expect(
        client.query(
          'SELECT * FROM public.activate_adherence_history_origin()',
        ),
      ).rejects.toMatchObject({ code: '22012' });
      await client.query('ROLLBACK');
      expect(await count()).toBe(initial);
      await client.query('BEGIN');
      await client.query(
        'SELECT * FROM public.activate_adherence_history_origin()',
      );
      await client.query('ROLLBACK');
      expect(await count()).toBe(initial);
      expect(
        await read(
          pool,
          'SELECT * FROM public.adherence_history_baselines ORDER BY epoch_id,source_table,row_key',
        ),
      ).toEqual(images);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('rejects nonowner execute/read and non READ COMMITTED activation', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await expect(
        client.query(
          'SELECT * FROM public.activate_adherence_history_origin()',
        ),
      ).rejects.toMatchObject({ code: '25001' });
      await client.query('ROLLBACK');
      await client.query('BEGIN');
      await client.query('CREATE ROLE origin_denied');
      await client.query('SET LOCAL ROLE origin_denied');
      await expect(
        client.query(
          'SELECT * FROM public.activate_adherence_history_origin()',
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await client.query('ROLLBACK');
      const privileges = await read(
        client,
        `SELECT has_function_privilege('public', 'public.activate_adherence_history_origin()', 'EXECUTE') allowed`,
      );
      expect(privileges).toEqual([{ allowed: false }]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('legitimate nonsuperuser owner captures full images with nullable optional metadata', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('CREATE ROLE origin_fixture_owner');
      // PG17 exposes control metadata to PUBLIC by default on this image.
      // Deny it only inside this rolled-back fixture transaction, without grants.
      await client.query(
        'REVOKE EXECUTE ON FUNCTION pg_catalog.pg_control_system(), pg_catalog.pg_control_checkpoint() FROM PUBLIC',
      );
      await client.query(
        'GRANT USAGE, CREATE ON SCHEMA public TO origin_fixture_owner',
      );
      for (const table of [
        ...sources,
        'adherence_assignment_journal',
        'adherence_catalog_journal',
        'adherence_history_epochs',
        'adherence_history_baselines',
        'adherence_commit_evidence',
      ])
        await client.query(
          `ALTER TABLE public.${table} OWNER TO origin_fixture_owner`,
        );
      await client.query(`DO $$ DECLARE seq text; BEGIN
        seq := pg_catalog.pg_get_serial_sequence('public.adherence_assignment_journal','event_sequence');
        EXECUTE format('ALTER SEQUENCE %s OWNER TO origin_fixture_owner', seq);
      END $$`);
      await client.query(
        'ALTER FUNCTION public.capture_adherence_assignment_event() OWNER TO origin_fixture_owner',
      );
      await client.query(
        'ALTER FUNCTION public.capture_adherence_catalog_event() OWNER TO origin_fixture_owner',
      );
      await client.query(
        'GRANT EXECUTE ON FUNCTION public.assert_adherence_commit_owner(), public.activate_adherence_history_origin() TO origin_fixture_owner',
      );
      await client.query('SET LOCAL ROLE origin_fixture_owner');
      expect(
        await read(
          client,
          "SELECT has_function_privilege(current_user,'pg_catalog.pg_control_system()','EXECUTE') allowed",
        ),
      ).toEqual([{ allowed: false }]);
      const epoch = (
        await read<{ id: string }>(
          client,
          'SELECT * FROM public.activate_adherence_history_origin()',
        )
      )[0];
      expect(
        await read(
          client,
          'SELECT source_system_identifier,source_timeline,source_database_oid FROM public.adherence_history_epochs WHERE id=$1',
          [epoch.id],
        ),
      ).toEqual([
        {
          source_system_identifier: null,
          source_timeline: null,
          source_database_oid: null,
        },
      ]);
      expect(
        await read(
          client,
          'SELECT count(DISTINCT source_table)::int n FROM public.adherence_history_baselines WHERE epoch_id=$1',
          [epoch.id],
        ),
      ).toEqual([{ n: 13 }]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('issues activation and post-boundary event proof on real fenced COMMIT', async () => {
    const lease = await activate();
    expect(
      (await persistAdherenceCommitEvidence(lease, request(lease))).status,
    ).toBe('proof');
    const writer = await pool.connect();
    let xid: string;
    try {
      await writer.query('BEGIN');
      xid = (
        await read<{ xid: string }>(
          writer,
          'SELECT pg_current_xact_id()::text xid',
        )
      )[0].xid;
      await writer.query(
        "UPDATE public.trainings SET name='After activation' WHERE id='t'",
      );
      await writer.query(
        "UPDATE public.plan_assignments SET updated_at=clock_timestamp() WHERE id='pa'",
      );
      await writer.query('COMMIT');
    } finally {
      writer.release();
    }
    const evidence = await persistAdherenceCommitEvidence(lease, {
      ...request(lease),
      fullXid: xid,
    });
    expect(evidence.status).toBe('proof');
    if (evidence.status === 'proof')
      expect(BigInt(evidence.proof.event_count)).toBeGreaterThanOrEqual(2n);
    await lease.close();
    const sql: AdherenceCommitSql = {
      $queryRaw<T>(
        query: TemplateStringsArray | Prisma.Sql,
        ...values: unknown[]
      ) {
        const s = 'raw' in query ? Prisma.sql(query, ...values) : query;
        // Raw generic type is the caller's Prisma-compatible result declaration.
        return new RawPromise<T>((resolve, reject) => {
          void pool
            .query(s.text, s.values)
            .then((result) => resolve(result.rows as T), reject);
        });
      },
    };
    expect(
      await validateStoredAdherenceCommitEvidence(sql, request(lease)),
    ).toMatchObject({ status: 'proof' });
  });

  it('real pg_terminate_backend permanently invalidates origin without rebinding', async () => {
    const client = await pool.connect();
    const backendPid = await pid(client);
    const lease = await activateAdherenceHistoryOrigin(client);
    leases.push(lease);
    await pool.query('SELECT pg_terminate_backend($1)', [backendPid]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await persistAdherenceCommitEvidence(lease, request(lease))).toEqual(
      {
        status: 'unknown',
      },
    );
    await expect(lease.withSession(() => Promise.resolve(1))).rejects.toThrow();
    expect(await proofCount(lease.epochId)).toBe(0);
  });

  it('fence and issuance row lock remain held until actual COMMIT acknowledgement', async () => {
    const transport = new Transport(await pool.connect());
    const transportPid = await pid(transport.client);
    const lease = await activateAdherenceHistoryOrigin(transport);
    leases.push(lease);
    let finish!: () => void;
    transport.commitGate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const issuance = persistAdherenceCommitEvidence(lease, request(lease));
    const competitor = await pool.connect();
    try {
      const competitorPid = await pid(competitor);
      for (let i = 0; i < 200 && !transport.commitWaiting; i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(transport.commitWaiting).toBe(true);
      expect(await proofCount(lease.epochId)).toBe(0);
      await competitor.query('BEGIN');
      const waiting = competitor.query(
        'SELECT id FROM public.adherence_history_epochs WHERE id=$1 FOR UPDATE',
        [lease.epochId],
      );
      await blocked(competitorPid, transportPid);
      finish();
      expect((await issuance).status).toBe('proof');
      await waiting;
      await competitor.query('ROLLBACK');
    } finally {
      finish();
      await issuance;
      await competitor.query('ROLLBACK');
      competitor.release();
    }
  });

  it('lost fence AFTER actual INSERT rolls back: no durable proof exists', async () => {
    const transport = new Transport(await pool.connect());
    const lease = await activateAdherenceHistoryOrigin(transport);
    leases.push(lease);
    transport.loseFenceAfterIssue = true;
    expect(await persistAdherenceCommitEvidence(lease, request(lease))).toEqual(
      {
        status: 'unknown',
      },
    );
    expect(await proofCount(lease.epochId)).toBe(0);
    await expect(lease.withSession(() => Promise.resolve(1))).rejects.toThrow();
  });

  it('simulated transport COMMIT ACK loss is UNKNOWN and cannot blindly reissue', async () => {
    const transport = new Transport(await pool.connect());
    const lease = await activateAdherenceHistoryOrigin(transport);
    leases.push(lease);
    transport.loseCommitAck = true;
    expect(await persistAdherenceCommitEvidence(lease, request(lease))).toEqual(
      {
        status: 'unknown',
      },
    );
    expect(await proofCount(lease.epochId)).toBe(1);
    expect(await persistAdherenceCommitEvidence(lease, request(lease))).toEqual(
      {
        status: 'unknown',
      },
    );
  });
});
