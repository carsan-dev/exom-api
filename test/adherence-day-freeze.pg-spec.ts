import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseError, Pool, type PoolClient } from 'pg';
import { Test, type TestingModule } from '@nestjs/testing';
import { PrismaClient, Role } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { AdherenceConfigModule } from '../src/modules/adherence/adherence-config.module';
import {
  AdherenceEvaluationService,
  type AdherenceDayResult,
} from '../src/modules/adherence/adherence-evaluation.service';

// ADH-FREEZE-01 U1: table, SQL constructor and daily freeze job on a fresh
// owned PostgreSQL 17. The schema/upgrade checks use a scratch database of the
// same disposable cluster, migrated file by file up to 20261115120000 with
// legacy fixtures, so the freeze range (driven by the earliest stored row) is
// never shared with other suites.
const ROOT = resolve(__dirname, '..');
const MIGRATIONS = join(ROOT, 'prisma/migrations');
const TARGET = '20261117120000_adherence_day_bases';
const PREVIOUS = '20261115120000_base_service_scope';
const CONSTRUCTORS = [
  'public.exom_adherence_unit_occurrences(text,date,text)',
  'public.exom_adherence_day_basis(text,date)',
];
const JOBS = [
  'public.exom_freeze_adherence_day_bases_at(timestamptz,integer,interval)',
  'public.exom_freeze_adherence_day_bases()',
];
const TRIGGER_FUNCTIONS = [
  'public.exom_immutable_adherence_day_basis()',
  'public.exom_reject_adherence_day_basis_truncate()',
];
const SUPABASE_ROLES = ['anon', 'authenticated', 'service_role'];
const SOURCE_TABLES = [
  'users',
  'plan_assignments',
  'plan_assignment_trainings',
  'training_exercises',
  'training_day_snapshots',
  'adherence_day_bases',
];
const FREEZE_AT =
  'SELECT public.exom_freeze_adherence_day_bases_at($1::timestamptz) AS r';
const FREEZE_WITH =
  'SELECT public.exom_freeze_adherence_day_bases_at($1::timestamptz, $2::integer, $3::interval) AS r';

type Db = Pool | PoolClient;
type Unit = { id: string; training_id: string; occurrences: string[] };
type Basis = {
  version: number;
  assigned: boolean;
  assignment_id?: string;
  rest?: boolean;
  completion_mode?: string;
  diet_id?: string | null;
  units?: Unit[];
};
type FreezeResult = {
  from: string;
  to: string;
  targets: number;
  inserted: number;
  late: number;
};
type Row = {
  client_id: string;
  date: string;
  version: number;
  provenance: string;
  captured_at: string;
  basis: Basis;
};

const hex = () => randomUUID().replaceAll('-', '');
const migrationNames = () =>
  readdirSync(MIGRATIONS)
    .filter((name) => /^\d/.test(name))
    .sort();
const migrationSql = (name: string) =>
  readFileSync(join(MIGRATIONS, name, 'migration.sql'), 'utf8');

async function failure(
  work: Promise<unknown>,
): Promise<{ code: string | undefined; message: string }> {
  try {
    await work;
  } catch (error) {
    if (error instanceof DatabaseError)
      return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error('Expected a database error');
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Blocked')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function backendPid(client: PoolClient): Promise<number> {
  const { rows } = await client.query<{ pid: number }>(
    'SELECT pg_backend_pid() AS pid',
  );
  return rows[0].pid;
}

async function waitForLock(monitor: Db, pid: number): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const { rows } = await monitor.query<{ waiting: boolean }>(
      "SELECT wait_event_type = 'Lock' AS waiting FROM pg_stat_activity WHERE pid = $1",
      [pid],
    );
    if (rows[0]?.waiting) return;
    await new Promise((done) => setTimeout(done, 25));
  }
  throw new Error('Expected the backend to wait on a lock');
}

describe('adherence day freeze on fresh owned PG17', () => {
  let main: Pool;
  let scratch: Pool;
  let scratchName: string;
  const createdRoles: string[] = [];
  const users: string[] = [];
  let legacyDigest: Map<string, string>;
  let upgradedDigest: Map<string, string>;
  let busyUsersMigration: {
    code: string | undefined;
    elapsed: number;
    table: string | null;
  };

  async function tableDigests(db: Db): Promise<Map<string, string>> {
    const { rows: tables } = await db.query<{ name: string }>(
      "SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'adherence_day_bases' ORDER BY tablename",
    );
    const digests = new Map<string, string>();
    for (const { name } of tables) {
      const identifier = '"' + name.replaceAll('"', '""') + '"';
      const { rows } = await db.query<{ digest: string }>(
        `SELECT md5(coalesce(string_agg(t::text, E'\\n' ORDER BY t::text), '')) AS digest FROM public.${identifier} t`,
      );
      digests.set(name, rows[0].digest);
    }
    return digests;
  }

  async function createUser(
    db: Db,
    id: string,
    options: {
      role?: 'CLIENT' | 'ADMIN';
      created?: string;
      active?: boolean;
      archived?: boolean;
      locked?: boolean;
      pending?: boolean;
    } = {},
  ): Promise<string> {
    await db.query(
      `INSERT INTO public.users(id, email, firebase_uid, role, created_at, updated_at,
         is_active, is_archived, is_locked, identity_pending)
       VALUES ($1, $1 || '@example.test', $1, $2::"Role", $3::timestamp, now(), $4, $5, $6, $7)`,
      [
        id,
        options.role ?? 'CLIENT',
        options.created ?? '2020-01-01T00:00:00',
        options.active ?? true,
        options.archived ?? false,
        options.locked ?? false,
        options.pending ?? false,
      ],
    );
    users.push(id);
    return id;
  }

  async function createTraining(
    db: Db,
    occurrences: string[],
  ): Promise<string> {
    const training = 't-' + hex();
    const exercise = 'x-' + hex();
    await db.query(
      `INSERT INTO public.trainings(id, name, type, tags, updated_at) VALUES ($1, 'Freeze', 'STRENGTH', '{}', now())`,
      [training],
    );
    await db.query(
      `INSERT INTO public.exercises(id, name, muscle_groups, equipment, updated_at) VALUES ($1, 'Squat', '{}', '{}', now())`,
      [exercise],
    );
    for (const [order, id] of occurrences.entries()) {
      await db.query(
        `INSERT INTO public.training_exercises(id, training_id, exercise_id, "order", sets, reps_or_duration)
         VALUES ($1, $2, $3, $4, 3, '8-12')`,
        [id, training, exercise, order],
      );
    }
    return training;
  }

  async function createDiet(db: Db): Promise<string> {
    const diet = 'd-' + hex();
    await db.query(
      `INSERT INTO public.diets(id, name, updated_at) VALUES ($1, 'Freeze', now())`,
      [diet],
    );
    return diet;
  }

  async function createAssignment(
    db: Db,
    client: string,
    date: string,
    options: {
      id?: string;
      training?: string | null;
      diet?: string | null;
      rest?: boolean;
      mode?: 'ALL' | 'ANY';
    } = {},
  ): Promise<string> {
    const id = options.id ?? 'a-' + hex();
    await db.query(
      `INSERT INTO public.plan_assignments(id, client_id, date, training_id, diet_id, is_rest_day,
         training_completion_mode, updated_at)
       VALUES ($1, $2, $3::date, $4, $5, $6, $7::"TrainingCompletionMode", now())`,
      [
        id,
        client,
        date,
        options.training ?? null,
        options.diet ?? null,
        options.rest ?? false,
        options.mode ?? 'ALL',
      ],
    );
    return id;
  }

  async function createLink(
    db: Db,
    id: string,
    assignment: string,
    training: string,
    position: number,
  ): Promise<void> {
    await db.query(
      `INSERT INTO public.plan_assignment_trainings(id, assignment_id, training_id, position) VALUES ($1, $2, $3, $4)`,
      [id, assignment, training, position],
    );
  }

  async function createSnapshot(
    db: Db,
    client: string,
    date: string,
    training: string,
    exercises: string[],
  ): Promise<void> {
    await db.query(
      `INSERT INTO public.training_day_snapshots(client_id, date, training_id, payload)
       VALUES ($1, $2::date, $3, $4::jsonb)`,
      [
        client,
        date,
        training,
        JSON.stringify({
          id: training,
          exercises: exercises.map((id) => ({ id })),
        }),
      ],
    );
  }

  async function basisOf(db: Db, client: string, date: string): Promise<Basis> {
    const { rows } = await db.query<{ basis: Basis }>(
      'SELECT public.exom_adherence_day_basis($1, $2::date) AS basis',
      [client, date],
    );
    return rows[0].basis;
  }

  async function freeze(
    db: Db,
    now: string,
    catchup?: number,
    grace?: string,
  ): Promise<FreezeResult> {
    const { rows } =
      catchup === undefined && grace === undefined
        ? await db.query<{ r: FreezeResult }>(FREEZE_AT, [now])
        : await db.query<{ r: FreezeResult }>(FREEZE_WITH, [
            now,
            catchup ?? 7,
            grace ?? '2 hours',
          ]);
    return rows[0].r;
  }

  // 'scheduled' is decided by the real transaction clock, so a synthetic p_now
  // only gets it with a grace that covers the real time elapsed since the end
  // of its closed day: exactly that time plus `extra` (strict bound).
  async function freezeOnTime(
    db: Db,
    now: string,
    extra = '1 hour',
    catchup = 7,
  ): Promise<FreezeResult> {
    const { rows } = await db.query<{ r: FreezeResult }>(
      `SELECT public.exom_freeze_adherence_day_bases_at($1::timestamptz, $2::integer,
         transaction_timestamp()
           - (date_trunc('day', $1::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
           + $3::interval) AS r`,
      [now, catchup, extra],
    );
    return rows[0].r;
  }

  async function stored(db: Db, clients?: string[]): Promise<Row[]> {
    const { rows } = await db.query<Row>(
      `SELECT client_id, to_char(date, 'YYYY-MM-DD') AS date, version, provenance,
         to_char(captured_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS captured_at, basis
       FROM public.adherence_day_bases
       WHERE $1::text[] IS NULL OR client_id = ANY($1::text[])
       ORDER BY client_id COLLATE "C", date`,
      [clients ?? null],
    );
    return rows;
  }

  async function count(db: Db): Promise<number> {
    const { rows } = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM public.adherence_day_bases',
    );
    return rows[0].n;
  }

  beforeAll(async () => {
    const url = process.env.TEST_DATABASE_URL;
    if (!url) throw new Error('TEST_DATABASE_URL required');
    main = new Pool({ connectionString: url, ssl: false });
    const identity = await main.query<{
      db: string;
      role: string;
      dir: string;
    }>(
      "SELECT current_database() AS db, current_user AS role, current_setting('data_directory') AS dir",
    );
    expect(identity.rows[0]).toEqual({
      db: 'exom_ci',
      role: 'exom_ci',
      dir: '/var/lib/postgresql/exom-ci-data',
    });
    for (const role of SUPABASE_ROLES) {
      const { rows } = await main.query(
        'SELECT 1 FROM pg_roles WHERE rolname = $1',
        [role],
      );
      if (!rows.length) {
        await main.query(`CREATE ROLE ${role} NOLOGIN`);
        createdRoles.push(role);
      }
    }
    scratchName = 'exom_ci_freeze_' + hex();
    await main.query(`CREATE DATABASE ${scratchName}`);
    const target = new URL(url);
    target.pathname = '/' + scratchName;
    scratch = new Pool({
      connectionString: target.toString(),
      ssl: false,
      max: 8,
    });
    const scratchIdentity = await scratch.query<{
      db: string;
      role: string;
      dir: string;
    }>(
      "SELECT current_database() AS db, current_user AS role, current_setting('data_directory') AS dir",
    );
    expect(scratchIdentity.rows[0]).toEqual({
      db: scratchName,
      role: 'exom_ci',
      dir: '/var/lib/postgresql/exom-ci-data',
    });

    const names = migrationNames();
    const position = names.indexOf(TARGET);
    expect(position).toBeGreaterThan(0);
    expect(names[position - 1]).toBe(PREVIOUS);
    for (const name of names.slice(0, position))
      await scratch.query(migrationSql(name));

    // Supabase grants new public objects to its API roles by default.
    await scratch.query(
      `GRANT USAGE ON SCHEMA public TO ${SUPABASE_ROLES.join(', ')}`,
    );
    await scratch.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${SUPABASE_ROLES.join(', ')}`,
    );
    await scratch.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO ${SUPABASE_ROLES.join(', ')}`,
    );
    const probe = 'probe_' + hex();
    await scratch.query(`CREATE TABLE public.${probe} (id int)`);
    const control = await scratch.query<{ granted: boolean }>(
      `SELECT has_table_privilege('service_role', 'public.${probe}', 'SELECT') AS granted`,
    );
    expect(control.rows[0].granted).toBe(true);
    await scratch.query(`DROP TABLE public.${probe}`);

    // Legacy fixtures: assignment, link, snapshots, revision and a v1 prescription.
    const legacy = 'legacy-' + hex();
    await scratch.query(
      `INSERT INTO public.users(id, email, firebase_uid, updated_at) VALUES ($1, $1 || '@example.test', $1, now())`,
      [legacy],
    );
    const training = await createTraining(scratch, ['o-' + hex()]);
    const diet = await createDiet(scratch);
    const assignment = await createAssignment(scratch, legacy, '2024-06-01', {
      training,
      diet,
    });
    await createLink(scratch, 'l-' + hex(), assignment, training, 0);
    await createSnapshot(scratch, legacy, '2024-06-02', training, ['o-legacy']);
    await scratch.query(
      `INSERT INTO public.adherence_evaluation_revisions(client_id, date, revision, idempotency_key,
         original_basis_digest, config_digest, evidence_digest, evaluation)
       VALUES ($1, '2024-06-01', 1, 'k1', 'current_fallback:v1:x', 'c', 'e',
         '{"date":"2024-06-01","revision":1,"evaluation":{"period":"closed"}}')`,
      [legacy],
    );
    await scratch.query(
      `INSERT INTO public.adherence_historical_prescriptions(client_id, date, payload)
       VALUES ($1, '2024-06-01', jsonb_build_object('prescription',
         jsonb_build_object('client_id', $1::text, 'date', '2024-06-01', 'version', 1)))`,
      [legacy],
    );
    // The legacy client (created now, so outside every frozen range) is kept.
    legacyDigest = await tableDigests(scratch);
    expect(legacyDigest.size).toBeGreaterThan(20);

    // A writer holding users: the migration must give up on its own instead
    // of queueing every users write behind it (cancelled at 20 s otherwise).
    const holder = await scratch.connect();
    const migrator = await scratch.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE public.users IN ROW EXCLUSIVE MODE');
      const pid = await backendPid(migrator);
      const started = Date.now();
      const attempt = failure(migrator.query(migrationSql(TARGET)));
      const guard = setTimeout(() => {
        void scratch.query('SELECT pg_cancel_backend($1)', [pid]);
      }, 20000);
      const error = await attempt;
      clearTimeout(guard);
      const elapsed = Date.now() - started;
      await migrator.query('ROLLBACK');
      const { rows } = await migrator.query<{ table: string | null }>(
        "SELECT to_regclass('public.adherence_day_bases')::text AS table",
      );
      busyUsersMigration = { code: error.code, elapsed, table: rows[0].table };
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
      migrator.release();
    }

    await scratch.query(migrationSql(TARGET));
    upgradedDigest = await tableDigests(scratch);
    for (const name of names.slice(position + 1))
      await scratch.query(migrationSql(name));
  }, 300000);

  afterAll(async () => {
    await scratch?.end();
    if (scratchName && main) {
      await main.query(`DROP DATABASE IF EXISTS ${scratchName} WITH (FORCE)`);
    }
    for (const role of createdRoles) await main.query(`DROP ROLE ${role}`);
    await main?.end();
  });

  afterEach(async () => {
    if (users.length)
      await scratch.query('DELETE FROM public.users WHERE id = ANY($1)', [
        users.splice(0),
      ]);
  });

  describe('1. migration', () => {
    async function structure(db: Db) {
      const { rows: table } = await db.query<{
        rls: boolean;
        force: boolean;
        policies: number;
        public_acl: number;
      }>(
        `SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
           (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS policies,
           (SELECT count(*)::int FROM aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a WHERE a.grantee = 0) AS public_acl
         FROM pg_class c WHERE c.oid = 'public.adherence_day_bases'::regclass`,
      );
      expect(table).toEqual([
        { rls: true, force: false, policies: 0, public_acl: 0 },
      ]);
      const { rows: functions } = await db.query<{
        name: string;
        volatility: string;
        definer: boolean;
        config: string[];
        public_acl: number;
      }>(
        `SELECT p.oid::regprocedure::text AS name, p.provolatile AS volatility, p.prosecdef AS definer,
           coalesce(p.proconfig, '{}') AS config,
           (SELECT count(*)::int FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0) AS public_acl
         FROM pg_proc p WHERE p.oid = ANY($1::regprocedure[]) ORDER BY 1`,
        [[...CONSTRUCTORS, ...JOBS, ...TRIGGER_FUNCTIONS]],
      );
      expect(functions).toHaveLength(6);
      for (const fn of functions) {
        expect(fn.definer).toBe(false);
        expect(fn.public_acl).toBe(0);
        expect(fn.config).toContain('search_path=pg_catalog');
      }
      const byName = new Map(functions.map((fn) => [fn.name, fn]));
      for (const name of CONSTRUCTORS)
        expect(byName.get(name.replace('public.', ''))?.volatility).toBe('s');
      for (const name of JOBS) {
        const fn = byName.get(
          name
            .replace('public.', '')
            .replace('timestamptz', 'timestamp with time zone'),
        );
        expect(fn?.volatility).toBe('v');
        for (const setting of [
          'search_path=pg_catalog',
          'TimeZone=UTC',
          'lock_timeout=35s',
        ])
          expect(fn?.config).toContain(setting);
      }
    }

    it('installs from scratch with migrate deploy (main database)', async () => {
      const { rows } = await main.query<{ applied: number }>(
        `SELECT count(*)::int AS applied FROM public._prisma_migrations
         WHERE migration_name = $1 AND finished_at IS NOT NULL AND rolled_back_at IS NULL`,
        [TARGET],
      );
      expect(rows[0].applied).toBe(1);
      await structure(main);
    });

    it('upgrades a database migrated to 20261115120000 without touching its data', async () => {
      expect(upgradedDigest).toEqual(legacyDigest);
      expect(await tableDigests(scratch)).toEqual(legacyDigest);
      expect(await count(scratch)).toBe(0);
      await structure(scratch);
    });

    it('gives up after its 5 s lock_timeout when users is busy and leaves nothing behind', () => {
      expect(busyUsersMigration.code).toBe('55P03');
      expect(busyUsersMigration.table).toBeNull();
      expect(busyUsersMigration.elapsed).toBeGreaterThanOrEqual(4500);
      expect(busyUsersMigration.elapsed).toBeLessThan(15000);
    });

    it('revokes every privilege of the Supabase API roles', async () => {
      for (const role of SUPABASE_ROLES) {
        const { rows } = await scratch.query<{
          table: boolean;
          fns: boolean[];
        }>(
          `SELECT has_table_privilege($1, 'public.adherence_day_bases',
             'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') AS table,
             ARRAY(SELECT has_function_privilege($1, f, 'EXECUTE') FROM unnest($2::regprocedure[]) f) AS fns`,
          [role, [...CONSTRUCTORS, ...JOBS, ...TRIGGER_FUNCTIONS]],
        );
        expect(rows[0]).toEqual({ table: false, fns: Array(6).fill(false) });
      }
    });

    it('never mentions pg_cron nor creates extensions', () => {
      expect(migrationSql(TARGET)).not.toMatch(
        /pg_cron|\bcron\.|create\s+extension/i,
      );
    });

    it('keeps rows immutable except for the owning user cascade', async () => {
      const keep = await createUser(scratch, 'keep-' + hex());
      const gone = await createUser(scratch, 'gone-' + hex());
      await createAssignment(scratch, keep, '2024-03-01');
      await freeze(scratch, '2024-03-02T00:05:00Z');
      expect(await count(scratch)).toBe(2);
      for (const statement of [
        `UPDATE public.adherence_day_bases SET provenance = 'late' WHERE client_id = '${keep}'`,
        `UPDATE public.adherence_day_bases SET basis = '{"version":1,"assigned":false}' WHERE client_id = '${keep}'`,
        `DELETE FROM public.adherence_day_bases WHERE client_id = '${keep}'`,
        'TRUNCATE public.adherence_day_bases',
      ]) {
        expect((await failure(scratch.query(statement))).code).toBe('23514');
      }
      for (const [version, provenance, basis] of [
        [2, 'late', '{"version":1,"assigned":false}'],
        [1, 'manual', '{"version":1,"assigned":false}'],
        [1, 'late', '{"version":2,"assigned":false}'],
        [1, 'late', '{"version":1}'],
        [1, 'late', '{"assigned":false}'],
        [1, 'late', '{"version":1,"assigned":"false"}'],
        [1, 'late', '[]'],
      ] as const) {
        const error = await failure(
          scratch.query(
            `INSERT INTO public.adherence_day_bases(client_id, date, version, provenance, basis)
             VALUES ($1, '2024-01-01', $2, $3, $4::jsonb)`,
            [keep, version, provenance, basis],
          ),
        );
        expect(error.code).toBe('23514');
      }
      expect(await count(scratch)).toBe(2);
      await scratch.query('DELETE FROM public.users WHERE id = $1', [gone]);
      expect((await stored(scratch)).map((row) => row.client_id)).toEqual([
        keep,
      ]);
    });
  });

  describe('constructor exom_adherence_day_basis', () => {
    const date = '2024-02-01';

    it('freezes "not assigned" for a date without assignment, despite another client assigned that date', async () => {
      const client = await createUser(scratch, 'c-' + hex());
      const decoy = await createUser(scratch, 'decoy-' + hex());
      const training = await createTraining(scratch, ['o-' + hex()]);
      await createAssignment(scratch, client, '2024-02-02');
      const other = await createAssignment(scratch, decoy, date, {
        training,
        diet: await createDiet(scratch),
      });
      await createLink(scratch, 'l-' + hex(), other, training, 0);
      expect((await basisOf(scratch, decoy, date)).assigned).toBe(true);
      expect(await basisOf(scratch, client, date)).toEqual({
        version: 1,
        assigned: false,
      });
    });

    it('keeps the completion mode on a rest day and drops its units', async () => {
      const client = await createUser(scratch, 'c-' + hex());
      const training = await createTraining(scratch, ['o-' + hex()]);
      const assignment = await createAssignment(scratch, client, date, {
        rest: true,
        mode: 'ANY',
      });
      await createLink(scratch, 'l-' + hex(), assignment, training, 0);
      expect(await basisOf(scratch, client, date)).toEqual({
        version: 1,
        assigned: true,
        assignment_id: assignment,
        rest: true,
        completion_mode: 'ANY',
        diet_id: null,
        units: [],
      });
    });

    it('builds the inherited unit with the assignment id when there are no links', async () => {
      const client = await createUser(scratch, 'c-' + hex());
      const p = hex();
      const training = await createTraining(scratch, [p + '-b', p + '-a']);
      const diet = await createDiet(scratch);
      const assignment = await createAssignment(scratch, client, date, {
        training,
        diet,
      });
      expect(await basisOf(scratch, client, date)).toEqual({
        version: 1,
        assigned: true,
        assignment_id: assignment,
        rest: false,
        completion_mode: 'ALL',
        diet_id: diet,
        units: [
          {
            id: assignment,
            training_id: training,
            occurrences: [p + '-a', p + '-b'],
          },
        ],
      });
    });

    it('reads the inherited unit from its day snapshot, untouched by another client assigned that date', async () => {
      const client = await createUser(scratch, 'c-' + hex());
      const decoy = await createUser(scratch, 'decoy-' + hex());
      const p = hex();
      const training = await createTraining(scratch, [p + '-catalog']);
      await createSnapshot(scratch, client, date, training, [
        p + '-s2',
        p + '-s1',
      ]);
      const assignment = await createAssignment(scratch, client, date, {
        training,
        mode: 'ANY',
      });
      const other = await createAssignment(scratch, decoy, date, {
        training,
      });
      await createLink(scratch, p + '-decoy', other, training, 0);
      await createSnapshot(scratch, decoy, date, training, [p + '-decoy']);
      expect(await basisOf(scratch, client, date)).toEqual({
        version: 1,
        assigned: true,
        assignment_id: assignment,
        rest: false,
        completion_mode: 'ANY',
        diet_id: null,
        units: [
          {
            id: assignment,
            training_id: training,
            occurrences: [p + '-s1', p + '-s2'],
          },
        ],
      });
    });

    it('orders links by position (not id), ignores the legacy mirror and sorts occurrences byte-wise', async () => {
      const client = await createUser(scratch, 'c-' + hex());
      const p = hex();
      const first = await createTraining(scratch, [
        p + '-a',
        p + '-B',
        p + '-A',
      ]);
      const second = await createTraining(scratch, [p + '-z']);
      const third = await createTraining(scratch, [p + '-m']);
      const assignment = await createAssignment(scratch, client, date, {
        training: first,
      });
      await createLink(scratch, p + '-m', assignment, third, 2);
      await createLink(scratch, p + '-z', assignment, first, 0);
      await createLink(scratch, p + '-a', assignment, second, 1);
      const basis = await basisOf(scratch, client, date);
      expect(basis.units).toEqual([
        {
          id: p + '-z',
          training_id: first,
          occurrences: [p + '-A', p + '-B', p + '-a'],
        },
        { id: p + '-a', training_id: second, occurrences: [p + '-z'] },
        { id: p + '-m', training_id: third, occurrences: [p + '-m'] },
      ]);
    });

    it('reads occurrences from the day snapshot first, even when it is empty, scoped to client and date', async () => {
      const client = await createUser(scratch, 'c-' + hex());
      const decoy = await createUser(scratch, 'decoy-' + hex());
      const p = hex();
      const timed = await createTraining(scratch, [p + '-catalog']);
      const emptied = await createTraining(scratch, [p + '-still']);
      const reps = await createTraining(scratch, [p + '-r2', p + '-r1']);
      await createSnapshot(scratch, client, date, timed, [
        p + '-s2',
        p + '-s1',
      ]);
      await createSnapshot(scratch, client, date, emptied, []);
      await createSnapshot(scratch, client, '2024-02-02', reps, [
        p + '-other-date',
      ]);
      await createSnapshot(scratch, decoy, date, reps, [p + '-decoy']);
      const assignment = await createAssignment(scratch, client, date, {
        mode: 'ANY',
      });
      await createLink(scratch, p + '-1', assignment, timed, 0);
      await createLink(scratch, p + '-2', assignment, emptied, 1);
      await createLink(scratch, p + '-3', assignment, reps, 2);
      const basis = await basisOf(scratch, client, date);
      expect(basis.completion_mode).toBe('ANY');
      expect(basis.units).toEqual([
        {
          id: p + '-1',
          training_id: timed,
          occurrences: [p + '-s1', p + '-s2'],
        },
        { id: p + '-2', training_id: emptied, occurrences: [] },
        {
          id: p + '-3',
          training_id: reps,
          occurrences: [p + '-r1', p + '-r2'],
        },
      ]);
    });

    it('has no unit once the inherited training is deleted (SetNull)', async () => {
      const client = await createUser(scratch, 'c-' + hex());
      const training = await createTraining(scratch, ['o-' + hex()]);
      const assignment = await createAssignment(scratch, client, date, {
        training,
      });
      await scratch.query('DELETE FROM public.trainings WHERE id = $1', [
        training,
      ]);
      expect(await basisOf(scratch, client, date)).toEqual({
        version: 1,
        assigned: true,
        assignment_id: assignment,
        rest: false,
        completion_mode: 'ALL',
        diet_id: null,
        units: [],
      });
    });

    it('keeps ANY with a single unit', async () => {
      const client = await createUser(scratch, 'c-' + hex());
      const p = hex();
      const training = await createTraining(scratch, [p + '-o']);
      const assignment = await createAssignment(scratch, client, date, {
        mode: 'ANY',
      });
      await createLink(scratch, p + '-l', assignment, training, 0);
      const basis = await basisOf(scratch, client, date);
      expect(basis.completion_mode).toBe('ANY');
      expect(basis.units).toEqual([
        { id: p + '-l', training_id: training, occurrences: [p + '-o'] },
      ]);
    });
  });

  describe('freeze job', () => {
    beforeEach(async () => {
      expect(await count(scratch)).toBe(0);
    });

    it('5. freezes only the closed day on an empty table, then fills missed nights as late', async () => {
      const client = await createUser(scratch, 'c-' + hex());
      const training = await createTraining(scratch, ['o-' + hex()]);
      await createAssignment(scratch, client, '2025-03-10', { training });
      expect(await freezeOnTime(scratch, '2025-03-11T00:05:00Z')).toEqual({
        from: '2025-03-10',
        to: '2025-03-10',
        targets: 1,
        inserted: 1,
        late: 0,
      });
      let rows = await stored(scratch, [client]);
      expect(rows.map((r) => [r.date, r.provenance, r.basis.assigned])).toEqual(
        [['2025-03-10', 'scheduled', true]],
      );
      expect(rows[0].version).toBe(1);

      // Rows up to D-5: D-4..D-1 late, D scheduled while the real clock is
      // still within the grace window (one microsecond inside).
      expect(
        await freezeOnTime(scratch, '2025-03-16T01:59:59Z', '1 microsecond'),
      ).toEqual({
        from: '2025-03-10',
        to: '2025-03-15',
        targets: 6,
        inserted: 5,
        late: 4,
      });
      rows = await stored(scratch, [client]);
      expect(rows.map((r) => [r.date, r.provenance])).toEqual([
        ['2025-03-10', 'scheduled'],
        ['2025-03-11', 'late'],
        ['2025-03-12', 'late'],
        ['2025-03-13', 'late'],
        ['2025-03-14', 'late'],
        ['2025-03-15', 'scheduled'],
      ]);
      expect(rows.slice(1).every((r) => r.basis.assigned === false)).toBe(true);

      // At the end of the grace window (strict bound) the closed day is late.
      expect(
        await freezeOnTime(scratch, '2025-03-17T02:00:00Z', '0'),
      ).toMatchObject({
        to: '2025-03-16',
        inserted: 1,
        late: 1,
      });

      // Catch-up is capped: only the last 7 closed days are recovered.
      expect(await freezeOnTime(scratch, '2025-03-30T00:05:00Z')).toEqual({
        from: '2025-03-23',
        to: '2025-03-29',
        targets: 7,
        inserted: 7,
        late: 6,
      });
      // p_catchup_days = 1 freezes the closed day only.
      expect(
        await freezeOnTime(scratch, '2025-04-05T00:05:00Z', '1 hour', 1),
      ).toEqual({
        from: '2025-04-04',
        to: '2025-04-04',
        targets: 1,
        inserted: 1,
        late: 0,
      });
      const dates = (await stored(scratch, [client])).map((r) => r.date);
      expect(dates).not.toContain('2025-03-17');
      expect(dates).not.toContain('2025-03-22');
      expect(dates).not.toContain('2025-04-03');
    });

    it('5. a manual run with the clock of a missed night days ago freezes every row late', async () => {
      const client = await createUser(scratch, 'c-' + hex());
      const today = new Date();
      const midnight = Date.UTC(
        today.getUTCFullYear(),
        today.getUTCMonth(),
        today.getUTCDate(),
      );
      // 00:05 UTC of an old night: on time by p_now alone, late by the real clock.
      const night = (daysAgo: number) =>
        new Date(midnight - daysAgo * 86400000 + 5 * 60000).toISOString();
      expect(await freeze(scratch, night(5))).toMatchObject({
        targets: 1,
        inserted: 1,
        late: 1,
      });
      expect(await freeze(scratch, night(3))).toMatchObject({
        targets: 3,
        inserted: 2,
        late: 2,
      });
      const rows = await stored(scratch, [client]);
      expect(rows).toHaveLength(3);
      expect(rows.every((r) => r.provenance === 'late')).toBe(true);
    });

    it('5. never freezes before the first stored row', async () => {
      const client = await createUser(scratch, 'c-' + hex());
      await freeze(scratch, '2025-06-10T00:05:00Z');
      const result = await freeze(scratch, '2025-06-10T00:06:00Z', 31);
      expect(result).toMatchObject({
        from: '2025-06-09',
        to: '2025-06-09',
        inserted: 0,
      });
      // An older clock than the first row has nothing to freeze.
      expect(await freeze(scratch, '2025-06-01T00:05:00Z')).toMatchObject({
        targets: 0,
        inserted: 0,
      });
      expect((await stored(scratch, [client])).map((r) => r.date)).toEqual([
        '2025-06-09',
      ]);
    });

    it('5. rejects future or invalid arguments without writing', async () => {
      await createUser(scratch, 'c-' + hex());
      const future = new Date(Date.now() + 86400000).toISOString();
      for (const [now, catchup, grace, code] of [
        [future, 7, '2 hours', '22023'],
        [null, 7, '2 hours', '22023'],
        ['2025-01-02T00:05:00Z', 0, '2 hours', '22023'],
        ['2025-01-02T00:05:00Z', 32, '2 hours', '22023'],
        ['2025-01-02T00:05:00Z', null, '2 hours', '22023'],
        ['2025-01-02T00:05:00Z', 7, null, '22023'],
        ['2025-01-02T00:05:00Z', 7, '-1 second', '22023'],
      ] as const) {
        const error = await failure(
          scratch.query(FREEZE_WITH, [now, catchup, grace]),
        );
        expect(error.code).toBe(code);
        expect(error.message).toMatch(/^adherence day freeze: /);
      }
      expect(await count(scratch)).toBe(0);
    });

    it('selects every CLIENT created before the end of the day, whatever its status (P1)', async () => {
      const p = hex();
      const included = [
        await createUser(scratch, p + '-active'),
        await createUser(scratch, p + '-archived', {
          archived: true,
          active: false,
        }),
        await createUser(scratch, p + '-locked', { locked: true }),
        await createUser(scratch, p + '-pending', { pending: true }),
        await createUser(scratch, p + '-sameday', {
          created: '2025-07-01T23:59:59.999',
        }),
      ];
      await createUser(scratch, p + '-admin', { role: 'ADMIN' });
      await createUser(scratch, p + '-later', {
        created: '2025-07-02T00:00:00',
      });
      expect(await freeze(scratch, '2025-07-02T00:05:00Z')).toMatchObject({
        targets: 5,
        inserted: 5,
      });
      expect((await stored(scratch)).map((r) => r.client_id)).toEqual(
        [...included].sort(),
      );
    });

    it('the scheduled entry point freezes the day that just closed (UTC)', async () => {
      const client = await createUser(scratch, 'c-' + hex());
      // Everything is derived from one transaction clock and rolled back, so a
      // run across 00:00 UTC (when the legacy client, created at suite start,
      // becomes a target) neither fails nor leaves rows behind.
      const db = await scratch.connect();
      try {
        await db.query('BEGIN');
        const { rows } = await db.query<{
          r: FreezeResult;
          yesterday: string;
          early: boolean;
          clients: number;
        }>(
          `SELECT public.exom_freeze_adherence_day_bases() AS r,
             to_char((transaction_timestamp() AT TIME ZONE 'UTC')::date - 1, 'YYYY-MM-DD') AS yesterday,
             (transaction_timestamp() AT TIME ZONE 'UTC')::time < time '02:00' AS early,
             (SELECT count(*)::int FROM public.users u WHERE u.role = 'CLIENT'
                AND u.created_at < (transaction_timestamp() AT TIME ZONE 'UTC')::date::timestamp) AS clients`,
        );
        const { r, yesterday, early, clients } = rows[0];
        expect(clients).toBeGreaterThanOrEqual(1);
        expect(r).toEqual({
          from: yesterday,
          to: yesterday,
          targets: clients,
          inserted: clients,
          late: early ? 0 : clients,
        });
        expect((await stored(db, [client])).map((row) => row.date)).toEqual([
          yesterday,
        ]);
      } finally {
        await db.query('ROLLBACK');
        db.release();
      }
      expect(await count(scratch)).toBe(0);
    });

    it('3. is idempotent: a second run inserts nothing and keeps the bytes', async () => {
      const client = await createUser(scratch, 'c-' + hex());
      const training = await createTraining(scratch, ['o-' + hex()]);
      await createAssignment(scratch, client, '2025-08-01', {
        training,
        mode: 'ANY',
      });
      const first = await freeze(scratch, '2025-08-02T00:05:00Z');
      const before = await stored(scratch);
      const second = await freeze(scratch, '2025-08-02T00:05:00Z');
      expect(first).toMatchObject({ targets: 1, inserted: 1 });
      expect(second).toEqual({ ...first, inserted: 0, late: 0 });
      expect(await stored(scratch)).toEqual(before);
    });

    it('3. two concurrent runs leave exactly one row per key', async () => {
      const p = hex();
      for (const suffix of ['a', 'b', 'c'])
        await createUser(scratch, p + '-' + suffix);
      const a = await scratch.connect();
      const b = await scratch.connect();
      try {
        await a.query('BEGIN');
        expect(await freeze(a, '2025-08-11T00:05:00Z')).toMatchObject({
          inserted: 3,
        });
        const pid = await backendPid(b);
        const second = freeze(b, '2025-08-11T00:05:00Z');
        await waitForLock(scratch, pid);
        await a.query('COMMIT');
        expect(await second).toMatchObject({ targets: 3, inserted: 0 });
      } finally {
        a.release();
        b.release();
      }
      const results = await Promise.all([
        freeze(scratch, '2025-08-13T00:05:00Z'),
        freeze(scratch, '2025-08-13T00:05:00Z'),
      ]);
      expect(results[0].inserted + results[1].inserted).toBe(6);
      const { rows } = await scratch.query<{ keys: number; total: number }>(
        'SELECT count(DISTINCT (client_id, date))::int AS keys, count(*)::int AS total FROM public.adherence_day_bases',
      );
      expect(rows[0]).toEqual({ keys: 9, total: 9 });
    });

    it('4a. an uncommitted edit neither blocks nor leaks into the frozen day', async () => {
      const client = await createUser(scratch, 'c-' + hex());
      const p = hex();
      const training = await createTraining(scratch, [p + '-o']);
      const assignment = await createAssignment(
        scratch,
        client,
        '2025-09-01',
        {},
      );
      await createLink(scratch, p + '-l', assignment, training, 0);
      const editor = await scratch.connect();
      try {
        await editor.query('BEGIN');
        await editor.query(
          `UPDATE public.plan_assignments SET is_rest_day = true, training_completion_mode = 'ANY' WHERE id = $1`,
          [assignment],
        );
        await editor.query(
          'DELETE FROM public.plan_assignment_trainings WHERE id = $1',
          [p + '-l'],
        );
        expect(
          await withTimeout(freeze(scratch, '2025-09-02T00:05:00Z'), 5000),
        ).toMatchObject({ inserted: 1 });
        await editor.query('COMMIT');
      } finally {
        editor.release();
      }
      const [row] = await stored(scratch, [client]);
      expect(row.basis).toEqual({
        version: 1,
        assigned: true,
        assignment_id: assignment,
        rest: false,
        completion_mode: 'ALL',
        diet_id: null,
        units: [
          { id: p + '-l', training_id: training, occurrences: [p + '-o'] },
        ],
      });
      // The live constructor follows the committed edit; the frozen row does not.
      expect(await basisOf(scratch, client, '2025-09-01')).toMatchObject({
        rest: true,
        completion_mode: 'ANY',
        units: [],
      });
      expect(await stored(scratch, [client])).toEqual([row]);
    });

    it('4b. an edit committed before the run is frozen (accepted window)', async () => {
      const client = await createUser(scratch, 'c-' + hex());
      const assignment = await createAssignment(scratch, client, '2025-09-10');
      await scratch.query(
        `UPDATE public.plan_assignments SET training_completion_mode = 'ANY' WHERE id = $1`,
        [assignment],
      );
      await freeze(scratch, '2025-09-11T00:05:00Z');
      const [row] = await stored(scratch, [client]);
      expect(row.basis.completion_mode).toBe('ANY');
    });

    it('4c. a concurrent client deletion fails the whole run without data and the retry freezes the rest', async () => {
      const p = hex();
      const first = await createUser(scratch, p + '-a');
      const deleted = await createUser(scratch, p + '-m');
      const last = await createUser(scratch, p + '-z');
      await createAssignment(scratch, deleted, '2025-10-01');
      const deleter = await scratch.connect();
      const job = await scratch.connect();
      let error: { code: string | undefined; message: string } | undefined;
      try {
        await deleter.query('BEGIN');
        await deleter.query('DELETE FROM public.users WHERE id = $1', [
          deleted,
        ]);
        const pid = await backendPid(job);
        const run = failure(freeze(job, '2025-10-02T00:05:00Z'));
        await waitForLock(scratch, pid);
        await deleter.query('COMMIT');
        error = await run;
      } finally {
        deleter.release();
        job.release();
      }
      expect(error).toEqual({
        code: '23503',
        message: 'adherence day freeze failed (SQLSTATE 23503)',
      });
      expect(error?.message).not.toMatch(/[0-9a-f]{32}|-[amz]\b|Key|client_id/);
      expect(await count(scratch)).toBe(0);
      expect(await freeze(scratch, '2025-10-02T00:05:00Z')).toMatchObject({
        targets: 2,
        inserted: 2,
      });
      expect((await stored(scratch)).map((r) => r.client_id)).toEqual([
        first,
        last,
      ]);
    });

    it('4e. waits behind the API per-client mutex (users FOR UPDATE) and then freezes', async () => {
      const client = await createUser(scratch, 'c-' + hex());
      await createAssignment(scratch, client, '2025-10-19');
      const mutex = await scratch.connect();
      const job = await scratch.connect();
      let waited = 0;
      try {
        await mutex.query('BEGIN');
        await mutex.query(
          'SELECT id FROM public.users WHERE id = $1 FOR UPDATE',
          [client],
        );
        const pid = await backendPid(job);
        const started = Date.now();
        const run = freeze(job, '2025-10-20T00:05:00Z');
        run.catch(() => undefined);
        await waitForLock(scratch, pid);
        await new Promise((done) => setTimeout(done, 1500));
        await mutex.query('COMMIT');
        expect(await run).toMatchObject({ targets: 1, inserted: 1 });
        waited = Date.now() - started;
      } finally {
        await mutex.query('ROLLBACK');
        mutex.release();
        job.release();
      }
      expect(waited).toBeGreaterThanOrEqual(1500);
      const rows = await stored(scratch, [client]);
      expect(rows.map((r) => [r.date, r.basis.assigned])).toEqual([
        ['2025-10-19', true],
      ]);
    });

    it('4d. no deadlock with diet, timed-training and RIR barriers under mixed edits', async () => {
      const client = await createUser(scratch, 'c-' + hex());
      const p = hex();
      const training = await createTraining(scratch, [p + '-o1', p + '-o2']);
      const other = await createTraining(scratch, [p + '-o3']);
      const diet = await createDiet(scratch);
      const days = Array.from(
        { length: 8 },
        (_, i) => `2025-11-${String(10 + i).padStart(2, '0')}`,
      );
      const assignments: string[] = [];
      for (const day of days) {
        const assignment = await createAssignment(scratch, client, day, {
          diet,
        });
        await createLink(scratch, `${p}-${day}`, assignment, training, 0);
        assignments.push(assignment);
      }
      async function edit(work: (db: PoolClient) => Promise<void>) {
        const db = await scratch.connect();
        try {
          await db.query('BEGIN');
          await work(db);
          await db.query('COMMIT');
        } catch (cause) {
          await db.query('ROLLBACK');
          throw cause;
        } finally {
          db.release();
        }
      }
      for (let i = 1; i < days.length; i++) {
        const outcomes = await Promise.allSettled([
          freeze(scratch, `${days[i]}T00:05:00Z`),
          edit(async (db) => {
            await db.query(
              `UPDATE public.plan_assignments SET training_completion_mode =
                 CASE training_completion_mode WHEN 'ALL' THEN 'ANY'::"TrainingCompletionMode" ELSE 'ALL' END
               WHERE id = ANY($1)`,
              [assignments],
            );
            await db.query(
              'INSERT INTO public.plan_assignment_trainings(id, assignment_id, training_id, position) VALUES ($1, $2, $3, 1)',
              [`${p}-extra-${i}`, assignments[i], other],
            );
          }),
          edit(async (db) => {
            await db.query(
              'UPDATE public.training_exercises SET sets = sets + 1 WHERE training_id = $1',
              [training],
            );
            await db.query(
              `UPDATE public.diets SET name = 'Freeze ' || $2 WHERE id = $1`,
              [diet, String(i)],
            );
          }),
          edit(async (db) => {
            await db.query(
              `INSERT INTO public.day_progress(id, client_id, date, meals_completed, notes, updated_at)
               VALUES ($1, $2, $3::date, '{}', 'done', now()) ON CONFLICT (client_id, date) DO NOTHING`,
              [`${p}-progress-${i}`, client, days[i]],
            );
          }),
        ]);
        const rejected = outcomes.filter((o) => o.status === 'rejected');
        expect(rejected).toEqual([]);
      }
      expect((await stored(scratch, [client])).map((r) => r.date)).toEqual(
        days.slice(0, -1),
      );
    }, 120000);

    describe('6. fail closed', () => {
      async function asOwner(
        configure: (db: PoolClient, role: string) => Promise<void>,
      ): Promise<{
        result?: FreezeResult;
        error?: { code: string | undefined; message: string };
      }> {
        const db = await scratch.connect();
        const role = 'freeze_owner_' + hex();
        try {
          await db.query('BEGIN');
          await db.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
          for (const table of SOURCE_TABLES)
            await db.query(`ALTER TABLE public.${table} OWNER TO ${role}`);
          await db.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
          for (const fn of [...CONSTRUCTORS, ...JOBS])
            await db.query(`GRANT EXECUTE ON FUNCTION ${fn} TO ${role}`);
          await configure(db, role);
          await db.query(`SET LOCAL ROLE ${role}`);
          const { rows: flags } = await db.query<{
            super: boolean;
            bypass: boolean;
          }>(
            'SELECT rolsuper AS super, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user',
          );
          expect(flags[0]).toEqual({ super: false, bypass: false });
          try {
            return { result: await freeze(db, '2025-12-02T00:05:00Z') };
          } catch (cause) {
            if (cause instanceof DatabaseError)
              return { error: { code: cause.code, message: cause.message } };
            throw cause;
          }
        } finally {
          await db.query('ROLLBACK');
          db.release();
        }
      }

      it('control: a non-bypass owner without FORCE RLS freezes normally', async () => {
        const client = await createUser(scratch, 'c-' + hex());
        await createAssignment(scratch, client, '2025-12-01');
        const outcome = await asOwner(() => Promise.resolve());
        expect(outcome.error).toBeUndefined();
        expect(outcome.result).toMatchObject({ targets: 1, inserted: 1 });
        expect(await count(scratch)).toBe(0); // rolled back
      });

      it('aborts with 42501 when FORCE RLS would hide assignments', async () => {
        const client = await createUser(scratch, 'c-' + hex());
        await createAssignment(scratch, client, '2025-12-01');
        const outcome = await asOwner(async (db) => {
          await db.query(
            'ALTER TABLE public.plan_assignments FORCE ROW LEVEL SECURITY',
          );
        });
        expect(outcome).toEqual({
          error: {
            code: '42501',
            message: 'adherence day freeze: row security active',
          },
        });
        expect(await count(scratch)).toBe(0);
      });

      it('reports only the SQLSTATE without SELECT privilege', async () => {
        const client = await createUser(scratch, 'c-' + hex());
        const training = await createTraining(scratch, ['o-' + hex()]);
        await createAssignment(scratch, client, '2025-12-01', { training });
        const outcome = await asOwner(async (db, role) => {
          await db.query(
            `REVOKE SELECT ON public.training_exercises FROM ${role}`,
          );
        });
        expect(outcome).toEqual({
          error: {
            code: '42501',
            message: 'adherence day freeze failed (SQLSTATE 42501)',
          },
        });
        expect(await count(scratch)).toBe(0);
      });
    });
  });

  // ADH-FREEZE-01 U2: the evaluation reads adherence_day_bases for closed
  // days (plan §3.3 and §8, tests 2 and 7). Same scratch database, so the
  // freeze job only sees this file's clients; afterEach deletes them, which
  // cascades to their frozen rows and keeps every freeze range independent.
  describe('U2 evaluation of frozen days', () => {
    let prismaPool: Pool;
    let prisma: PrismaClient;
    let module: TestingModule;
    let service: AdherenceEvaluationService;

    beforeAll(async () => {
      const url = process.env.TEST_DATABASE_URL;
      if (!url) throw new Error('TEST_DATABASE_URL required');
      const target = new URL(url);
      target.pathname = '/' + scratchName;
      prismaPool = new Pool({
        connectionString: target.toString(),
        ssl: false,
      });
      prisma = new PrismaClient({ adapter: new PrismaPg(prismaPool) });
      module = await Test.createTestingModule({
        imports: [PrismaModule, AdherenceConfigModule],
      })
        .overrideProvider(PrismaService)
        .useValue(prisma)
        .compile();
      service = module.get(AdherenceEvaluationService);
      const identity = await prisma.$queryRaw<{ db: string }[]>`
        SELECT current_database() AS db`;
      expect(identity[0].db).toBe(scratchName);
    });

    afterAll(async () => {
      await module?.close();
      await prisma?.$disconnect();
      if (prismaPool && !prismaPool.ended) await prismaPool.end();
    });

    const nextDay = (day: string) => {
      const at = new Date(day + 'T00:00:00Z');
      at.setUTCDate(at.getUTCDate() + 1);
      return at.toISOString().slice(0, 10);
    };
    const evaluate = (client: string, start: string, end = start) =>
      service.get(client, Role.CLIENT, client, { start, end });
    const withoutSource = (day: AdherenceDayResult) => {
      const copy: Partial<AdherenceDayResult> = { ...day };
      delete copy.basis;
      delete copy.revision;
      return copy;
    };

    async function revisions(client: string, day: string) {
      const { rows } = await scratch.query<{
        revision: number;
        original_basis_digest: string;
        original_basis_id: string | null;
        cut_binding: string | null;
      }>(
        `SELECT revision, original_basis_digest, original_basis_id, cut_binding
         FROM public.adherence_evaluation_revisions
         WHERE client_id = $1 AND date = $2::date ORDER BY revision`,
        [client, day],
      );
      return rows;
    }

    async function dietWithVariant(calories: number) {
      const ingredient = await prisma.ingredient.create({
        data: {
          name: 'U2 ' + hex(),
          calories_per_100g: 100,
          protein_per_100g: 10,
          carbs_per_100g: 0,
          fat_per_100g: 0,
        },
      });
      const diet = await prisma.diet.create({
        data: {
          name: 'U2',
          total_calories: calories,
          total_protein_g: calories / 20,
          meals: {
            create: [0, 1].map((order) => ({
              name: 'Root ' + order,
              type: 'BREAKFAST',
              order,
              nutritional_badges: [],
              ingredients: {
                create: {
                  ingredient_id: ingredient.id,
                  quantity: 100,
                  unit: 'g',
                },
              },
            })),
          },
        },
        include: { meals: { orderBy: { order: 'asc' } } },
      });
      const variant = await prisma.meal.create({
        data: {
          diet_id: diet.id,
          parent_meal_id: diet.meals[0].id,
          type: 'BREAKFAST',
          name: 'Variant',
          order: 1,
          nutritional_badges: [],
          ingredients: {
            create: { ingredient_id: ingredient.id, quantity: 70, unit: 'g' },
          },
        },
      });
      return {
        id: diet.id,
        root: diet.meals[0].id,
        second: diet.meals[1].id,
        variant: variant.id,
      };
    }

    // Session-proven evidence for the given trainings and meal selections.
    async function progress(
      client: string,
      day: string,
      units: Array<{ training: string; occurrences: string[] }>,
      meals: string[] = [],
    ) {
      const sessions = units.map((unit) => ({
        training_session_id: randomUUID(),
        training_id: unit.training,
        rpe: 8,
      }));
      await prisma.dayProgress.create({
        data: {
          client_id: client,
          date: new Date(day),
          sync_revision: 1,
          training_completed: false,
          trainings_completed: [],
          training_sessions: sessions,
          exercises_completed: units.flatMap((unit, index) =>
            unit.occurrences.map((occurrence) => ({
              training_session_id: sessions[index].training_session_id,
              training_exercise_id: occurrence,
              exercise_id: 'u2',
              completed_at: day + 'T12:00:00Z',
            })),
          ),
          meals_completed: meals,
        },
      });
    }

    async function policy(client: string) {
      await prisma.adherenceConfigRevision.create({
        data: {
          client_id: client,
          version: 1,
          effective_date: new Date('2020-01-01'),
          steps_goal: 1000,
          calorie_lower_percent: 10,
          calorie_upper_percent: 10,
          protein_min_percent: 90,
          steps_min_percent: 100,
          low_global_percent: 50,
        },
      });
    }

    // A real time prescription (measure_type SECONDS with its target).
    async function addTimedExercise(
      training: string,
      id: string,
      order: number,
    ) {
      const exercise = 'x-' + hex();
      await scratch.query(
        `INSERT INTO public.exercises(id, name, muscle_groups, equipment, updated_at) VALUES ($1, 'Plank', '{}', '{}', now())`,
        [exercise],
      );
      await scratch.query(
        `INSERT INTO public.training_exercises(id, training_id, exercise_id, "order", sets, reps_or_duration,
           measure_type, target_value)
         VALUES ($1, $2, $3, $4, 3, '30 s', 'SECONDS'::"TrainingMeasureType", 30)`,
        [id, training, exercise, order],
      );
    }

    async function timedSnapshots(
      client: string,
      day: string,
      training: string,
    ) {
      const { rows } = await scratch.query<{
        source: string;
        exercises: Array<{ id: string; measure_type: string }>;
      }>(
        `SELECT source, (SELECT jsonb_agg(jsonb_build_object('id', e->>'id', 'measure_type', e->>'measure_type')
             ORDER BY ordinality) FROM jsonb_array_elements(payload->'exercises') WITH ORDINALITY AS x(e, ordinality)) AS exercises
         FROM public.training_day_snapshots
         WHERE client_id = $1 AND date = $2::date AND training_id = $3`,
        [client, day, training],
      );
      return rows;
    }

    async function dietSnapshotCount(client: string, day: string) {
      const { rows } = await scratch.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM public.diet_day_snapshots
         WHERE client_id = $1 AND date = $2::date`,
        [client, day],
      );
      return rows[0].n;
    }

    it('2. a frozen day keeps the fallback basis hash and evaluation (SQL/TS equivalence matrix, decoy client)', async () => {
      const client = await createUser(scratch, 'c-' + hex());
      const decoy = await createUser(scratch, 'decoy-' + hex());
      await policy(client);
      const p = hex();
      const day = (n: number) => '2021-03-' + String(n).padStart(2, '0');
      const days = Array.from({ length: 12 }, (_, index) => day(index + 1));
      const reps = await createTraining(scratch, [p + '-r2', p + '-r1']);
      const other = await createTraining(scratch, [p + '-o1']);
      const timed = await createTraining(scratch, []);
      await addTimedExercise(timed, p + '-t2', 0);
      await addTimedExercise(timed, p + '-t1', 1);
      const emptied = await createTraining(scratch, [p + '-e-catalog']);
      const doomed = await createTraining(scratch, [p + '-d1']);
      const decoyTraining = await createTraining(scratch, [p + '-decoy']);
      const snapshotDiet = await dietWithVariant(1800);
      const plainDiet = await dietWithVariant(2000);
      const decoyDiet = await dietWithVariant(2600);
      // The decoy has another plan on every fixture date, and its own
      // training snapshot on the timed date.
      for (const [index, at] of days.entries()) {
        const assignment = await createAssignment(scratch, decoy, at, {
          diet: decoyDiet.id,
          mode: 'ANY',
        });
        await createLink(
          scratch,
          `${p}-decoy-${index}`,
          assignment,
          decoyTraining,
          0,
        );
      }
      // 1. Not assigned (the decoy is assigned that date).
      // 2. Rest day with links and ANY.
      const rest = await createAssignment(scratch, client, day(2), {
        rest: true,
        mode: 'ANY',
        diet: plainDiet.id,
      });
      await createLink(scratch, p + '-rest-1', rest, reps, 0);
      await createLink(scratch, p + '-rest-2', rest, other, 1);
      // 3. Inherited unit: training_id without links.
      await createAssignment(scratch, client, day(3), {
        training: reps,
        diet: plainDiet.id,
      });
      // 4. Several links whose position order is not their id order, plus
      // the legacy training_id mirror that links override.
      const ordered = await createAssignment(scratch, client, day(4), {
        training: other,
        diet: plainDiet.id,
      });
      await createLink(scratch, p + '-z', ordered, reps, 0);
      await createLink(scratch, p + '-a', ordered, other, 1);
      await progress(client, day(4), [
        { training: reps, occurrences: [p + '-r1', p + '-r2'] },
      ]);
      // 5. Timed (SECONDS) training read from its day snapshot (not the
      // catalog). The snapshot is not inserted by the test: writing the link
      // of the protected day updates the legacy training_id mirror
      // (20260904120000), whose timed_consumer_before trigger
      // (20260913120000) captures the day.
      const timedDay = await createAssignment(scratch, client, day(5), {
        diet: plainDiet.id,
      });
      expect(await timedSnapshots(client, day(5), timed)).toEqual([]);
      await createLink(scratch, p + '-timed', timedDay, timed, 0);
      await createSnapshot(scratch, decoy, day(5), timed, [p + '-t-decoy']);
      await progress(client, day(5), [
        { training: timed, occurrences: [p + '-t1', p + '-t2'] },
      ]);
      expect(await timedSnapshots(client, day(5), timed)).toEqual([
        {
          source: 'captured',
          exercises: [
            { id: p + '-t2', measure_type: 'SECONDS' },
            { id: p + '-t1', measure_type: 'SECONDS' },
          ],
        },
      ]);
      // A later catalog edit adds an exercise the day never prescribed.
      await addTimedExercise(timed, p + '-t3', 2);
      // 6. Day snapshot with exercises: [].
      const emptyDay = await createAssignment(scratch, client, day(6), {
        diet: plainDiet.id,
      });
      await createLink(scratch, p + '-emptied', emptyDay, emptied, 0);
      await createSnapshot(scratch, client, day(6), emptied, []);
      // 7. Repetitions-only training (catalog occurrences).
      const repsDay = await createAssignment(scratch, client, day(7), {
        diet: plainDiet.id,
      });
      await createLink(scratch, p + '-reps', repsDay, reps, 0);
      // 8. Inherited training deleted afterwards (SetNull).
      await createAssignment(scratch, client, day(8), {
        training: doomed,
        diet: plainDiet.id,
      });
      await scratch.query('DELETE FROM public.trainings WHERE id = $1', [
        doomed,
      ]);
      // 9. Diet with variants and a diet_day_snapshot (captured below).
      const dietDay = await createAssignment(scratch, client, day(9), {
        diet: snapshotDiet.id,
      });
      await createLink(scratch, p + '-diet', dietDay, reps, 0);
      await progress(
        client,
        day(9),
        [{ training: reps, occurrences: [p + '-r1', p + '-r2'] }],
        [snapshotDiet.variant, snapshotDiet.second],
      );
      // 10. Diet with variants resolved from the catalog, without any day
      // snapshot. In production this is a day assigned while it was still in
      // the future that closed with no progress and no later edit of its
      // diet: 20260906120000 captures only protected days (past or with
      // progress), so nothing ever snapshots it. A synthetic 2021 date is
      // always protected, so the two row capture triggers of plan_assignments
      // (AFTER INSERT, and BEFORE UPDATE fired by the legacy mirror sync of
      // the link) are disabled only inside the inserting transaction
      // (transactional DDL: no other session or statement sees them
      // disabled). No progress on this day, as in production (progress would
      // capture it).
      const captureTriggers = [
        'diet_history_assignment_after',
        'diet_history_assignment_before',
      ];
      const catalogDiet = await dietWithVariant(2200);
      const insert = await scratch.connect();
      try {
        await insert.query('BEGIN');
        for (const trigger of captureTriggers)
          await insert.query(
            `ALTER TABLE public.plan_assignments DISABLE TRIGGER ${trigger}`,
          );
        const plainDay = await createAssignment(insert, client, day(10), {
          diet: catalogDiet.id,
        });
        await createLink(insert, p + '-plain', plainDay, other, 0);
        // Run the deferred constraint triggers now, still with the capture
        // disabled (ALTER TABLE refuses pending trigger events).
        await insert.query('SET CONSTRAINTS ALL IMMEDIATE');
        for (const trigger of captureTriggers)
          await insert.query(
            `ALTER TABLE public.plan_assignments ENABLE TRIGGER ${trigger}`,
          );
        await insert.query('COMMIT');
      } catch (error) {
        await insert.query('ROLLBACK');
        throw error;
      } finally {
        insert.release();
      }
      const triggerState = await scratch.query<{
        name: string;
        enabled: string;
      }>(
        `SELECT tgname AS name, tgenabled AS enabled FROM pg_trigger
         WHERE tgrelid = 'public.plan_assignments'::regclass
           AND tgname = ANY($1::text[]) ORDER BY tgname`,
        [captureTriggers],
      );
      expect(triggerState.rows).toEqual(
        [...captureTriggers].sort().map((name) => ({ name, enabled: 'O' })),
      );
      // 11. Null diet.
      const noDiet = await createAssignment(scratch, client, day(11), {});
      await createLink(scratch, p + '-nodiet', noDiet, other, 0);
      // 12. ANY with a single unit.
      const single = await createAssignment(scratch, client, day(12), {
        mode: 'ANY',
        diet: plainDiet.id,
      });
      await createLink(scratch, p + '-single', single, other, 0);
      await progress(client, day(12), [
        { training: other, occurrences: [p + '-o1'] },
      ]);
      // A later catalog edit: the trigger copies the protected day 9 content
      // first, so day 9 reads its snapshot and not the edited quantities.
      await prisma.mealIngredient.updateMany({
        where: { meal: { diet_id: snapshotDiet.id } },
        data: { quantity: 80 },
      });
      const captured = await scratch.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM public.diet_day_snapshots
         WHERE client_id = $1 AND date = $2::date AND diet_id = $3`,
        [client, day(9), snapshotDiet.id],
      );
      expect(captured.rows[0].n).toBe(1);
      // Day 10 really has no diet snapshot at all before the first GET.
      expect(await dietSnapshotCount(client, day(10))).toBe(0);

      // 1) GET without frozen rows: every day is the current-plan fallback.
      const fallback = await evaluate(client, day(1), day(12));
      expect(fallback.days.map((d) => d.basis)).toEqual(
        days.map(() => 'current_fallback'),
      );
      // The fixtures exercise the shapes they claim (fallback side).
      const on = (n: number) => fallback.days[n - 1];
      expect(on(1).schedule).toEqual({
        training: 'not_assigned',
        nutrition: 'not_assigned',
      });
      expect(on(2).schedule.training).toBe('rest');
      expect(on(4).evaluation.training).toMatchObject({
        numerator: 1,
        denominator: 2,
      });
      // Proven only against the snapshot occurrences, not the catalog ones.
      expect(on(5).evaluation.training).toMatchObject({
        numerator: 1,
        denominator: 1,
      });
      expect(on(6).evaluation.training).toMatchObject({
        numerator: 0,
        denominator: 1,
      });
      expect(on(8).schedule.training).toBe('not_assigned');
      // Snapshot quantities 70 g + 100 g, not the edited 80 g + 80 g.
      expect(on(9).intake.estimated_calories).toBeCloseTo(170);
      // Catalog diet totals (no snapshot to read them from).
      expect(on(10).schedule.nutrition).toBe('assigned');
      expect(on(10).targets).toEqual({ calories: 2200, protein_g: 110 });
      expect(on(11).schedule.nutrition).toBe('not_assigned');
      expect(on(12).evaluation.training).toMatchObject({
        numerator: 1,
        denominator: 1,
      });
      const hashes = new Map<string, string>();
      for (const at of days) {
        const rows = await revisions(client, at);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          revision: 1,
          original_basis_id: null,
          cut_binding: null,
        });
        const match = /^current_fallback:v1:([0-9a-f]{64})$/.exec(
          rows[0].original_basis_digest,
        );
        if (!match) throw new Error('Unexpected fallback digest ' + at);
        hashes.set(at, match[1]);
      }

      // 2) The nightly job, on time, for each closed date.
      for (const at of days) {
        expect(
          await freezeOnTime(scratch, nextDay(at) + 'T00:05:00Z', '1 hour', 1),
        ).toMatchObject({ from: at, to: at, inserted: 2, late: 0 });
      }
      const frozenRows = await stored(scratch, [client]);
      expect(frozenRows.map((row) => [row.date, row.provenance])).toEqual(
        days.map((at) => [at, 'scheduled']),
      );
      const decoyRows = await stored(scratch, [decoy]);
      expect(decoyRows).toHaveLength(days.length);
      expect(frozenRows[0].basis).toEqual({ version: 1, assigned: false });
      expect(decoyRows[0].basis).toMatchObject({
        assigned: true,
        completion_mode: 'ANY',
        diet_id: decoyDiet.id,
      });
      // The frozen timed unit holds the captured occurrences, not the
      // catalog (which now also has t3).
      expect(frozenRows[4].basis.units).toEqual([
        {
          id: p + '-timed',
          training_id: timed,
          occurrences: [p + '-t1', p + '-t2'],
        },
      ]);
      expect(frozenRows[9].basis.diet_id).toBe(catalogDiet.id);
      // Still no diet snapshot for day 10 before the second GET.
      expect(await dietSnapshotCount(client, day(10))).toBe(0);

      // 3) GET again: frozen_day digest with the same hash, n+1 revision and
      // the same evaluation; only the source label and revision change.
      const frozen = await evaluate(client, day(1), day(12));
      expect(frozen.days.map((d) => d.basis)).toEqual(
        days.map(() => 'original'),
      );
      expect(frozen.days.map((d) => d.revision)).toEqual(days.map(() => 2));
      expect(frozen.days.map(withoutSource)).toEqual(
        fallback.days.map(withoutSource),
      );
      expect({ ...frozen, evaluated_at: null, days: null }).toEqual({
        ...fallback,
        evaluated_at: null,
        days: null,
      });
      for (const at of days) {
        const rows = await revisions(client, at);
        expect(rows).toHaveLength(2);
        expect(rows[1]).toEqual({
          revision: 2,
          original_basis_digest: 'frozen_day:v1:' + hashes.get(at),
          original_basis_id: null,
          cut_binding: null,
        });
      }
      // Replay: same keys, no new revision.
      expect((await evaluate(client, day(1), day(12))).days).toEqual(
        frozen.days,
      );
      for (const at of days)
        expect(await revisions(client, at)).toHaveLength(2);
    }, 120000);

    it('7. regression: a later plan edit no longer changes the evaluation of a frozen day', async () => {
      const client = await createUser(scratch, 'c-' + hex());
      await policy(client);
      const p = hex();
      const day = '2021-04-10';
      const reps = await createTraining(scratch, [p + '-r1']);
      const extra = await createTraining(scratch, [p + '-x1']);
      const diet = await dietWithVariant(1800);
      const otherDiet = await dietWithVariant(2400);
      const assignment = await createAssignment(scratch, client, day, {
        diet: diet.id,
        mode: 'ANY',
      });
      await createLink(scratch, p + '-l1', assignment, reps, 0);
      await createLink(scratch, p + '-l2', assignment, extra, 1);
      await progress(
        client,
        day,
        [{ training: reps, occurrences: [p + '-r1'] }],
        [diet.variant, diet.second],
      );
      expect(
        await freezeOnTime(scratch, nextDay(day) + 'T00:05:00Z', '1 hour', 1),
      ).toMatchObject({ inserted: 1, late: 0 });
      const before = await evaluate(client, day);
      // Later edits of the closed day: completion mode, membership, the
      // repetitions-only training content and the diet.
      await scratch.query(
        `UPDATE public.plan_assignments
         SET training_completion_mode = 'ALL', diet_id = $2 WHERE id = $1`,
        [assignment, otherDiet.id],
      );
      await createLink(
        scratch,
        p + '-l3',
        assignment,
        await createTraining(scratch, [p + '-y1']),
        2,
      );
      await scratch.query(
        `INSERT INTO public.training_exercises(id, training_id, exercise_id, "order", sets, reps_or_duration)
         SELECT $2, training_id, exercise_id, 1, 3, '8-12'
         FROM public.training_exercises WHERE id = $1`,
        [p + '-r1', p + '-r2'],
      );
      const after = await evaluate(client, day);
      // Before U2 the fallback followed the edited plan (ALL, three units, an
      // unproven occurrence, another diet) and appended a revision.
      expect(after.days).toEqual(before.days);
      expect(await revisions(client, day)).toHaveLength(1);
      expect(before.days[0]).toMatchObject({
        basis: 'original',
        calendar: 'complete',
        revision: 1,
        evaluation: { training: { numerator: 1, denominator: 1 } },
        targets: { calories: 1800, protein_g: 90 },
      });
    }, 60000);

    it('7. a late row is an estimate and stable; an invalid row stays unknown without fallback', async () => {
      const client = await createUser(scratch, 'c-' + hex());
      const p = hex();
      const late = '2021-05-10';
      const invalid = '2021-05-20';
      const reps = await createTraining(scratch, [p + '-r1']);
      const lateDay = await createAssignment(scratch, client, late, {});
      await createLink(scratch, p + '-late', lateDay, reps, 0);
      const invalidDay = await createAssignment(scratch, client, invalid, {});
      await createLink(scratch, p + '-invalid', invalidDay, reps, 0);
      // Default 2 h grace, real clock years later: frozen 'late'.
      expect(
        await freeze(scratch, nextDay(late) + 'T00:05:00Z', 1),
      ).toMatchObject({ inserted: 1, late: 1 });
      const first = await evaluate(client, late);
      expect(first.days[0]).toMatchObject({
        basis: 'current_fallback',
        schedule: { training: 'assigned', nutrition: 'not_assigned' },
      });
      expect((await revisions(client, late))[0].original_basis_digest).toMatch(
        /^frozen_day:v1:[0-9a-f]{64}$/,
      );
      await createLink(
        scratch,
        p + '-late-2',
        lateDay,
        await createTraining(scratch, [p + '-x1']),
        1,
      );
      expect((await evaluate(client, late)).days).toEqual(first.days);
      expect(await revisions(client, late)).toHaveLength(1);

      // A row that passes the table CHECKs but not the reader: unknown, and
      // the current plan (assigned) is not used in its place.
      await scratch.query(
        `INSERT INTO public.adherence_day_bases(client_id, date, provenance, basis)
         VALUES ($1, $2::date, 'scheduled', $3::jsonb)`,
        [
          client,
          invalid,
          JSON.stringify({ version: 1, assigned: true, rest: 'no' }),
        ],
      );
      const unknown = await evaluate(client, invalid);
      expect(unknown.days[0]).toMatchObject({
        basis: 'unknown',
        calendar: 'insufficient',
        schedule: { training: 'unknown', nutrition: 'unknown' },
      });
      expect(await revisions(client, invalid)).toEqual([
        {
          revision: 1,
          original_basis_digest: 'missing_original',
          original_basis_id: null,
          cut_binding: null,
        },
      ]);
    }, 60000);
  });
});
