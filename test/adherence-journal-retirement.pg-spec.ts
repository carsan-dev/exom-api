import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseError, Pool, type PoolClient } from 'pg';
import { ADHERENCE_JOURNAL_TRIGGERS } from './adherence-journal-triggers';

// ADH-FREEZE-01 U5: the 16 adherence journal capture triggers are disabled
// (not dropped) and activate_adherence_history_origin() refuses to open an
// epoch while any of them is not enabled. The upgrade checks use a scratch
// database of the same disposable cluster, migrated file by file up to
// 20261117120000 with legacy journal rows written by the live triggers.
const ROOT = resolve(__dirname, '..');
const MIGRATIONS = join(ROOT, 'prisma/migrations');
const TARGET = '20261118120000_disable_adherence_journal_triggers';
const PREVIOUS = '20261117120000_adherence_day_bases';
const ACTIVATE = 'public.activate_adherence_history_origin()';
// Single source of the 16 triggers, shared with the suites that re-enable
// them in setup.
const JOURNAL_TRIGGERS = ADHERENCE_JOURNAL_TRIGGERS;
const JOURNALS = ['adherence_assignment_journal', 'adherence_catalog_journal'];
const CAPTURE_FUNCTIONS = [
  ...new Set(JOURNAL_TRIGGERS.map(([, , fn]) => 'public.' + fn)),
].sort();
// The supported history operator (scripts/adherence-history-operator.cjs,
// acquire()) takes this session advisory lock before activation and keeps it
// until its lease closes; the migration tries the same key.
const OPERATOR = join(ROOT, 'scripts/adherence-history-operator.cjs');
const OPERATOR_LOCK_SQL = 'SELECT pg_try_advisory_lock($1, $2) AS ok';
const OPERATOR_LOCK = [60309, 31];

type Db = Pool | PoolClient;
type TriggerState = { table: string; trigger: string; enabled: string };
type FunctionShape = {
  identity: string;
  result: string;
  language: string;
  owner: string;
  acl: string | null;
  definer: boolean;
  volatility: string;
  config: string[] | null;
  comment: string | null;
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
): Promise<{ code: string | undefined; message: string; detail?: string }> {
  try {
    await work;
  } catch (error) {
    if (error instanceof DatabaseError)
      return { code: error.code, message: error.message, detail: error.detail };
    throw error;
  }
  throw new Error('Expected a database error');
}

async function backendPid(client: PoolClient): Promise<number> {
  const { rows } = await client.query<{ pid: number }>(
    'SELECT pg_backend_pid() AS pid',
  );
  return rows[0].pid;
}

// Ends the pool and waits for every socket before DROP DATABASE ... WITH
// (FORCE) (same race as ADH-FREEZE-FLAKE-01).
function poolCloser(pool: Pool): () => Promise<void> {
  const open = new Set<PoolClient>();
  pool.on('connect', (client) => open.add(client));
  pool.on('remove', (client) => open.delete(client));
  return async () => {
    if (!pool.ending) await pool.end();
    while (open.size) await once(pool, 'remove');
  };
}

async function journalTriggers(db: Db): Promise<TriggerState[]> {
  const { rows } = await db.query<TriggerState>(
    `SELECT e.tbl AS table, e.trg AS trigger, t.tgenabled::text AS enabled
     FROM unnest($1::text[], $2::text[], $3::text[]) AS e(tbl, trg, fn)
     LEFT JOIN pg_trigger t ON t.tgrelid = to_regclass('public.' || e.tbl)
       AND t.tgname = e.trg AND t.tgfoid = to_regprocedure('public.' || e.fn)
       AND NOT t.tgisinternal
     ORDER BY e.tbl COLLATE "C", e.trg COLLATE "C"`,
    [
      JOURNAL_TRIGGERS.map(([table]) => table),
      JOURNAL_TRIGGERS.map(([, trigger]) => trigger),
      JOURNAL_TRIGGERS.map(([, , fn]) => fn),
    ],
  );
  return rows;
}

// Every other user trigger of the database: the migration must not touch them.
async function otherTriggers(db: Db): Promise<TriggerState[]> {
  const { rows } = await db.query<TriggerState>(
    `SELECT c.relname AS table, t.tgname AS trigger, t.tgenabled::text AS enabled
     FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND NOT t.tgisinternal
       AND NOT (t.tgname = ANY($1::text[]))
     ORDER BY c.relname, t.tgname`,
    [[...new Set(JOURNAL_TRIGGERS.map(([, trigger]) => trigger))]],
  );
  return rows;
}

const allStates = (state: string) =>
  JOURNAL_TRIGGERS.map(([table, trigger]) => ({
    table,
    trigger,
    enabled: state,
  })).sort((a, b) =>
    a.table === b.table
      ? a.trigger < b.trigger
        ? -1
        : 1
      : a.table < b.table
        ? -1
        : 1,
  );

async function setTriggers(
  db: Db,
  action: 'ENABLE' | 'DISABLE',
  only?: readonly [string, string, string],
): Promise<void> {
  for (const entry of only ? [only] : JOURNAL_TRIGGERS)
    await db.query(
      `ALTER TABLE public.${entry[0]} ${action} TRIGGER ${entry[1]}`,
    );
}

async function functionShape(db: Db): Promise<FunctionShape> {
  const { rows } = await db.query<FunctionShape>(
    `SELECT p.oid::regprocedure::text AS identity,
       pg_get_function_result(p.oid) AS result,
       l.lanname AS language,
       pg_get_userbyid(p.proowner) AS owner,
       p.proacl::text AS acl,
       p.prosecdef AS definer,
       p.provolatile::text AS volatility,
       p.proconfig AS config,
       obj_description(p.oid, 'pg_proc') AS comment
     FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
     WHERE p.oid = to_regprocedure($1)`,
    [ACTIVATE],
  );
  expect(rows).toHaveLength(1);
  return rows[0];
}

async function functionSource(db: Db): Promise<string> {
  const { rows } = await db.query<{ src: string }>(
    'SELECT prosrc AS src FROM pg_proc WHERE oid = to_regprocedure($1)',
    [ACTIVATE],
  );
  return rows[0].src;
}

async function captureDigests(db: Db): Promise<Record<string, string>> {
  const { rows } = await db.query<{ fn: string; digest: string | null }>(
    `SELECT f.name AS fn, md5(p.prosrc) AS digest
     FROM unnest($1::text[]) AS f(name)
     LEFT JOIN pg_proc p ON p.oid = to_regprocedure(f.name)
     ORDER BY f.name`,
    [CAPTURE_FUNCTIONS],
  );
  expect(rows).toHaveLength(3);
  for (const row of rows) expect(row.digest).toMatch(/^[0-9a-f]{32}$/);
  return Object.fromEntries(rows.map((row) => [row.fn, row.digest ?? '']));
}

// Polls pg_locks until `waiter` is blocked by `blocker` (real lock queue).
async function waitBlocked(
  db: Db,
  waiter: number,
  blocker: number,
): Promise<void> {
  const deadline = Date.now() + 4000;
  for (;;) {
    const { rows } = await db.query<{ blocked: boolean }>(
      'SELECT $2::int = ANY(pg_blocking_pids($1)) AS blocked',
      [waiter, blocker],
    );
    if (rows[0].blocked) return;
    if (Date.now() > deadline)
      throw new Error(`Backend ${waiter} not blocked by ${blocker}`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

async function journalDigests(db: Db): Promise<Record<string, string>> {
  const digests: Record<string, string> = {};
  for (const journal of JOURNALS) {
    const { rows } = await db.query<{ digest: string; n: number }>(
      `SELECT md5(coalesce(string_agg(t::text, E'\\n' ORDER BY t.event_sequence), '')) AS digest,
         count(*)::int AS n FROM public.${journal} t`,
    );
    expect(rows[0].n).toBeGreaterThan(0);
    digests[journal] = rows[0].digest;
  }
  return digests;
}

// Epoch side effects of one activation attempt, including the shared
// allocator: a rejected attempt must not even consume a sequence value.
async function historyState(db: Db) {
  const { rows } = await db.query<{
    epochs: number;
    baselines: number;
    evidence: number;
    allocator: string;
  }>(
    `SELECT (SELECT count(*)::int FROM public.adherence_history_epochs) AS epochs,
       (SELECT count(*)::int FROM public.adherence_history_baselines) AS baselines,
       (SELECT count(*)::int FROM public.adherence_commit_evidence) AS evidence,
       (SELECT pg_sequence_last_value(
          pg_get_serial_sequence('public.adherence_assignment_journal', 'event_sequence')::regclass))::text
         AS allocator`,
  );
  return rows[0];
}

// One transaction that writes every one of the 16 covered tables (INSERT on
// all, plus UPDATE and DELETE), returning the per-source journal rows of it.
async function writeAll(pool: Pool): Promise<Record<string, string[]>> {
  const s = hex();
  const client = 'jr-c-' + s;
  const c = await pool.connect();
  let xid: string;
  try {
    await c.query('BEGIN');
    xid = (
      await c.query<{ xid: string }>('SELECT pg_current_xact_id()::text AS xid')
    ).rows[0].xid;
    for (const [sql, values] of [
      [
        `INSERT INTO users(id,email,firebase_uid,updated_at) VALUES ($1,$1 || '@example.test',$1,now())`,
        [client],
      ],
      [
        `INSERT INTO training_groups(id,name,normalized_name,updated_at) VALUES ($1,'Synthetic',$1,now())`,
        ['jr-tg-' + s],
      ],
      [
        `INSERT INTO diet_groups(id,name,normalized_name,updated_at) VALUES ($1,'Synthetic',$1,now())`,
        ['jr-dg-' + s],
      ],
      [
        `INSERT INTO catalog_colors(id,catalog_type,normalized_key,value,color,updated_at) VALUES ($1,'training_type',$1,'TEST','#abcdef',now())`,
        ['jr-cc-' + s],
      ],
      [
        `INSERT INTO trainings(id,name,type,types,tags,group_id,updated_at) VALUES ($1,'Synthetic','TEST',ARRAY['TEST'],'{}',$2,now())`,
        ['jr-t-' + s, 'jr-tg-' + s],
      ],
      [
        `INSERT INTO exercises(id,name,muscle_groups,equipment,updated_at) VALUES ($1,'Synthetic',ARRAY['TEST'],ARRAY['TEST'],now())`,
        ['jr-e-' + s],
      ],
      [
        `INSERT INTO training_blocks(id,training_id,"order",rounds,updated_at) VALUES ($1,$2,0,3,now())`,
        ['jr-b-' + s, 'jr-t-' + s],
      ],
      [
        `INSERT INTO training_exercises(id,training_id,exercise_id,block_id,"order",sets,reps_or_duration,measure_type,target_value_min,target_value_max,target_rir)
         VALUES ($1,$2,$3,$4,0,3,'8-12','REPS',8,12,3)`,
        ['jr-te-' + s, 'jr-t-' + s, 'jr-e-' + s, 'jr-b-' + s],
      ],
      [
        `INSERT INTO diets(id,name,tags,total_calories,total_protein_g,total_carbs_g,total_fat_g,group_id,updated_at) VALUES ($1,'Synthetic','{}',1800,130,200,60,$2,now())`,
        ['jr-d-' + s, 'jr-dg-' + s],
      ],
      [
        `INSERT INTO meals(id,diet_id,type,name,nutritional_badges,calories,protein_g,carbs_g,fat_g,updated_at) VALUES ($1,$2,'BREAKFAST','Synthetic','{}',400,30,50,10,now())`,
        ['jr-m-' + s, 'jr-d-' + s],
      ],
      [
        `INSERT INTO ingredients(id,name,calories_per_100g,protein_per_100g,carbs_per_100g,fat_per_100g,updated_at) VALUES ($1,'Synthetic',300,20,40,10,now())`,
        ['jr-i-' + s],
      ],
      [
        `INSERT INTO meal_ingredients(id,meal_id,ingredient_id,quantity,grams_equivalent) VALUES ($1,$2,$3,100,95)`,
        ['jr-mi-' + s, 'jr-m-' + s, 'jr-i-' + s],
      ],
      // A future date: never protected, so no diet snapshot side effect.
      [
        `INSERT INTO plan_assignments(id,client_id,date,diet_id,updated_at) VALUES ($1,$2,'2099-01-01',$3,now())`,
        ['jr-pa-' + s, client, 'jr-d-' + s],
      ],
      [
        `INSERT INTO plan_assignment_trainings(id,assignment_id,training_id,position) VALUES ($1,$2,$3,0)`,
        ['jr-pat-' + s, 'jr-pa-' + s, 'jr-t-' + s],
      ],
      [
        `INSERT INTO diet_day_snapshots(client_id,date,diet_id,provenance,diet)
         VALUES ($1,'2099-01-02',$2,'legacy_available',jsonb_build_object('id',$2::text,'meals','[]'::jsonb))`,
        [client, 'jr-d-' + s],
      ],
      [
        `INSERT INTO training_day_snapshots(client_id,date,training_id,payload)
         VALUES ($1,'2099-01-02',$2,jsonb_build_object('id',$2::text,'exercises','[]'::jsonb,'blocks','[]'::jsonb))`,
        [client, 'jr-t-' + s],
      ],
      [
        `INSERT INTO rir_day_targets(client_id,date,training_exercise_id,training_id,target_rir) VALUES ($1,'2099-01-02',$2,$3,1)`,
        [client, 'jr-te-' + s, 'jr-t-' + s],
      ],
      [`UPDATE trainings SET name = 'Renamed' WHERE id = $1`, ['jr-t-' + s]],
      [
        `UPDATE plan_assignments SET notes = 'Edited' WHERE id = $1`,
        ['jr-pa-' + s],
      ],
      [`DELETE FROM plan_assignment_trainings WHERE id = $1`, ['jr-pat-' + s]],
    ] as const)
      await c.query(sql, [...values]);
    await c.query('COMMIT');
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  } finally {
    c.release();
  }
  const { rows } = await pool.query<{ source: string; ops: string[] }>(
    `SELECT source_table AS source, array_agg(operation ORDER BY event_sequence) AS ops
     FROM (SELECT source_table, operation, event_sequence FROM public.adherence_assignment_journal WHERE transaction_id = $1
           UNION ALL
           SELECT source_table, operation, event_sequence FROM public.adherence_catalog_journal WHERE transaction_id = $1) j
     GROUP BY source_table`,
    [xid],
  );
  return Object.fromEntries(rows.map((row) => [row.source, row.ops]));
}

async function activate(db: Db) {
  const { rows } = await db.query<{ id: string }>(`SELECT * FROM ${ACTIVATE}`);
  return rows;
}

describe('adherence journal retirement on fresh owned PG17', () => {
  let main: Pool;
  let scratch: Pool;
  let closeScratch: (() => Promise<void>) | undefined;
  let scratchName: string;
  let legacyJournal: Record<string, string[]>;
  let legacyDigests: Record<string, string>;
  let previousShape: FunctionShape;
  let previousSource: string;
  let previousOthers: TriggerState[];
  let previousJournalTriggers: TriggerState[];
  let busyMigration: {
    code: string | undefined;
    elapsed: number;
    triggers: TriggerState[];
    source: string;
  };
  let previousCaptureDigests: Record<string, string>;
  let inFlight: {
    operatorLocked: boolean;
    migrationCode: string | undefined;
    activation: string;
    newEpochs: number;
    triggers: TriggerState[];
  };
  let operatorHeld: {
    code: string | undefined;
    message: string;
    elapsed: number;
    triggers: TriggerState[];
    source: string;
  };

  beforeAll(async () => {
    const url = process.env.TEST_DATABASE_URL;
    if (!url) throw new Error('TEST_DATABASE_URL required');
    main = new Pool({ connectionString: url, ssl: false });
    const identity = await main.query(
      "SELECT current_database() AS db, current_user AS role, current_setting('data_directory') AS dir",
    );
    expect(identity.rows[0]).toEqual({
      db: 'exom_ci',
      role: 'exom_ci',
      dir: '/var/lib/postgresql/exom-ci-data',
    });
    scratchName = 'exom_ci_journal_' + hex();
    await main.query(`CREATE DATABASE ${scratchName}`);
    const target = new URL(url);
    target.pathname = '/' + scratchName;
    scratch = new Pool({
      connectionString: target.toString(),
      ssl: false,
      max: 8,
    });
    closeScratch = poolCloser(scratch);
    const scratchIdentity = await scratch.query(
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

    // Legacy journal rows, written by the live triggers before the upgrade.
    previousJournalTriggers = await journalTriggers(scratch);
    legacyJournal = await writeAll(scratch);
    legacyDigests = await journalDigests(scratch);
    previousShape = await functionShape(scratch);
    previousSource = await functionSource(scratch);
    previousCaptureDigests = await captureDigests(scratch);
    previousOthers = await otherTriggers(scratch);

    // A writer holding one covered table (the last one the migration locks):
    // the migration must give up after its lock_timeout with nothing changed.
    const holder = await scratch.connect();
    const migrator = await scratch.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(
        'LOCK TABLE public.training_day_snapshots IN ROW EXCLUSIVE MODE',
      );
      const pid = await backendPid(migrator);
      const started = Date.now();
      // Settled, not asserted here: P6 checks the outcome on its own.
      const attempt = failure(migrator.query(migrationSql(TARGET))).catch(
        () => ({ code: undefined }),
      );
      const guard = setTimeout(() => {
        void scratch.query('SELECT pg_cancel_backend($1)', [pid]);
      }, 20000);
      const error = await attempt;
      clearTimeout(guard);
      const elapsed = Date.now() - started;
      await migrator.query('ROLLBACK');
      busyMigration = {
        code: error.code,
        elapsed,
        triggers: await journalTriggers(migrator),
        source: await functionSource(migrator),
      };
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
      migrator.release();
    }

    // Cutover race. Writer C holds the last covered table; migration A takes
    // the first 15 and waits for it; the operator B arrives (its session
    // advisory lock, then the OLD activation body, which queues behind A on
    // the first table); C releases before A's lock_timeout. B must not open
    // an epoch once A has disabled the triggers. A is the real upgrade here.
    const epochsBefore = (await historyState(scratch)).epochs;
    const writer = await scratch.connect();
    const upgrader = await scratch.connect();
    const operator = await scratch.connect();
    let migration: Promise<string | undefined> = Promise.resolve(undefined);
    let activation: Promise<string> = Promise.resolve('not started');
    try {
      await writer.query('BEGIN');
      await writer.query(
        'LOCK TABLE public.training_day_snapshots IN ROW EXCLUSIVE MODE',
      );
      const writerPid = await backendPid(writer);
      const upgraderPid = await backendPid(upgrader);
      const operatorPid = await backendPid(operator);
      migration = upgrader.query(migrationSql(TARGET)).then(
        () => undefined,
        (error: unknown) =>
          error instanceof DatabaseError ? (error.code ?? '?') : String(error),
      );
      await waitBlocked(scratch, upgraderPid, writerPid);
      const operatorLocked = (
        await operator.query<{ ok: boolean }>(OPERATOR_LOCK_SQL, OPERATOR_LOCK)
      ).rows[0].ok;
      if (operatorLocked) {
        await operator.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        activation = operator.query(`SELECT * FROM ${ACTIVATE}`).then(
          async () => {
            await operator.query('COMMIT');
            return 'epoch committed';
          },
          async (error: unknown) => {
            await operator.query('ROLLBACK');
            return `rejected ${error instanceof DatabaseError ? error.code : String(error)}`;
          },
        );
        await waitBlocked(scratch, operatorPid, upgraderPid);
      }
      await writer.query('ROLLBACK');
      const migrationCode = await migration;
      if (migrationCode !== undefined) await upgrader.query('ROLLBACK');
      inFlight = {
        operatorLocked,
        migrationCode,
        activation: await activation,
        newEpochs: (await historyState(scratch)).epochs - epochsBefore,
        triggers: await journalTriggers(scratch),
      };
    } finally {
      await writer.query('ROLLBACK');
      await migration;
      await activation;
      await operator.query('SELECT pg_advisory_unlock_all()');
      writer.release();
      upgrader.release();
      operator.release();
    }
    // Applied by A above unless the race aborted it (P7 reports that).
    if (inFlight.migrationCode !== undefined)
      await scratch.query(migrationSql(TARGET));

    // Operator already holding its lock (e.g. during its lease): the
    // migration must stop at once, before any table lock or change. The
    // triggers are re-enabled first so that "nothing changed" is observable.
    await setTriggers(scratch, 'ENABLE');
    const heldSource = await functionSource(scratch);
    const lockHolder = await scratch.connect();
    const blockedMigrator = await scratch.connect();
    try {
      const locked = (
        await lockHolder.query<{ ok: boolean }>(
          OPERATOR_LOCK_SQL,
          OPERATOR_LOCK,
        )
      ).rows[0].ok;
      if (!locked) throw new Error('Operator advisory lock unavailable');
      const started = Date.now();
      let code: string | undefined;
      let message = 'applied';
      try {
        await blockedMigrator.query(migrationSql(TARGET));
      } catch (error) {
        if (!(error instanceof DatabaseError)) throw error;
        code = error.code;
        message = error.message;
        await blockedMigrator.query('ROLLBACK');
      }
      const elapsed = Date.now() - started;
      operatorHeld = {
        code,
        message,
        elapsed,
        triggers: await journalTriggers(scratch),
        source:
          (await functionSource(scratch)) === heldSource
            ? 'unchanged'
            : 'changed',
      };
    } finally {
      await lockHolder.query('SELECT pg_advisory_unlock_all()');
      lockHolder.release();
      blockedMigrator.release();
      await setTriggers(scratch, 'DISABLE');
    }

    for (const name of names.slice(position + 1))
      await scratch.query(migrationSql(name));
  }, 300000);

  afterAll(async () => {
    await closeScratch?.();
    if (scratchName && main)
      await main.query(`DROP DATABASE IF EXISTS ${scratchName} WITH (FORCE)`);
    await main?.end();
  });

  describe('P1. migration', () => {
    it('finds the 16 journal triggers enabled before the upgrade (control)', () => {
      expect(previousJournalTriggers).toEqual(allStates('O'));
      expect(JOURNAL_TRIGGERS).toHaveLength(16);
    });

    it('installs from scratch with migrate deploy (main database): 16 triggers disabled', async () => {
      const { rows } = await main.query<{ applied: number }>(
        `SELECT count(*)::int AS applied FROM public._prisma_migrations
         WHERE migration_name = $1 AND finished_at IS NOT NULL AND rolled_back_at IS NULL`,
        [TARGET],
      );
      expect(rows[0].applied).toBe(1);
      expect(await journalTriggers(main)).toEqual(allStates('D'));
    });

    it('upgrade disables exactly the 16 triggers and keeps functions, journals and their rows', async () => {
      expect(await journalTriggers(scratch)).toEqual(allStates('D'));
      expect(await otherTriggers(scratch)).toEqual(previousOthers);
      const { rows } = await scratch.query<{ missing: string[] }>(
        `SELECT array_remove(ARRAY[
           CASE WHEN to_regprocedure('public.capture_adherence_assignment_event()') IS NULL THEN 'assignment' END,
           CASE WHEN to_regprocedure('public.capture_adherence_catalog_event()') IS NULL THEN 'catalog' END,
           CASE WHEN to_regprocedure('public.capture_adherence_effective_event()') IS NULL THEN 'effective' END,
           CASE WHEN to_regclass('public.adherence_assignment_journal') IS NULL THEN 'assignment_journal' END,
           CASE WHEN to_regclass('public.adherence_catalog_journal') IS NULL THEN 'catalog_journal' END],
           NULL) AS missing`,
      );
      expect(rows[0].missing).toEqual([]);
      expect(await captureDigests(scratch)).toEqual(previousCaptureDigests);
      expect(await journalDigests(scratch)).toEqual(legacyDigests);
    });
  });

  describe('P2. edits no longer write journal rows', () => {
    it('journaled every covered table before the upgrade (control)', () => {
      // Other existing triggers add side-effect writes (legacy mirror sync of
      // plan_assignments, RIR target refresh), journaled too: at least the
      // statements issued by writeAll, per table and in order.
      expect(Object.keys(legacyJournal).sort()).toEqual(
        [...new Set(JOURNAL_TRIGGERS.map(([table]) => table))].sort(),
      );
      const issued: Record<string, string[]> = {
        plan_assignment_trainings: ['INSERT', 'DELETE'],
        plan_assignments: ['INSERT', 'UPDATE'],
        trainings: ['INSERT', 'UPDATE'],
      };
      for (const [table, ops] of Object.entries(legacyJournal)) {
        expect(ops[0]).toBe('INSERT');
        expect(ops).toEqual(expect.arrayContaining(issued[table] ?? []));
      }
    });

    it('writes nothing to either journal after the upgrade', async () => {
      expect(await writeAll(scratch)).toEqual({});
      expect(await journalDigests(scratch)).toEqual(legacyDigests);
    });
  });

  describe('P3. activation is rejected while any journal trigger is disabled', () => {
    it('rejects with all 16 disabled and leaves no epoch, baseline or allocator trace', async () => {
      const before = await historyState(scratch);
      const error = await failure(activate(scratch));
      expect(error.code).toBe('55000');
      expect(error.message).toBe(
        'History capture requires every adherence journal trigger enabled',
      );
      for (const [table, trigger] of JOURNAL_TRIGGERS)
        expect(error.detail).toContain(`${table}.${trigger}`);
      expect(await historyState(scratch)).toEqual(before);
    });

    it.each(
      JOURNAL_TRIGGERS.map((entry) => [`${entry[0]}.${entry[1]}`, entry]),
    )('rejects with only %s disabled', async (name, entry) => {
      await setTriggers(scratch, 'ENABLE');
      await setTriggers(scratch, 'DISABLE', entry);
      try {
        const before = await historyState(scratch);
        const error = await failure(activate(scratch));
        expect(error.code).toBe('55000');
        expect(error.detail).toBe(`Disabled or missing: ${name}`);
        expect(await historyState(scratch)).toEqual(before);
      } finally {
        await setTriggers(scratch, 'DISABLE');
      }
    });

    it('rejects when one journal trigger was dropped (missing, not disabled)', async () => {
      const [table, trigger] = JOURNAL_TRIGGERS[2];
      await setTriggers(scratch, 'ENABLE');
      const c = await scratch.connect();
      try {
        const before = await historyState(scratch);
        await c.query('BEGIN');
        await c.query(`DROP TRIGGER ${trigger} ON public.${table}`);
        const error = await failure(c.query(`SELECT * FROM ${ACTIVATE}`));
        expect(error.code).toBe('55000');
        expect(error.detail).toBe(`Disabled or missing: ${table}.${trigger}`);
        await c.query('ROLLBACK');
        expect(await historyState(scratch)).toEqual(before);
        expect(await journalTriggers(scratch)).toEqual(allStates('O'));
      } finally {
        await c.query('ROLLBACK');
        c.release();
        await setTriggers(scratch, 'DISABLE');
      }
    });

    it('rejects a trigger switched to replica-only firing', async () => {
      const [table, trigger] = JOURNAL_TRIGGERS[0];
      await setTriggers(scratch, 'ENABLE');
      await scratch.query(
        `ALTER TABLE public.${table} ENABLE REPLICA TRIGGER ${trigger}`,
      );
      try {
        const before = await historyState(scratch);
        const error = await failure(activate(scratch));
        expect(error.code).toBe('55000');
        expect(error.detail).toBe(`Disabled or missing: ${table}.${trigger}`);
        expect(await historyState(scratch)).toEqual(before);
      } finally {
        await setTriggers(scratch, 'DISABLE');
      }
    });
  });

  describe('P4. reversibility', () => {
    it('ENABLE TRIGGER on all 16 restores journaling and activation', async () => {
      await setTriggers(scratch, 'ENABLE');
      try {
        expect(await journalTriggers(scratch)).toEqual(allStates('O'));
        expect(await writeAll(scratch)).toEqual(legacyJournal);
        const before = await historyState(scratch);
        const epoch = await activate(scratch);
        expect(epoch).toHaveLength(1);
        expect(typeof epoch[0].id).toBe('string');
        expect((await historyState(scratch)).epochs).toBe(before.epochs + 1);
      } finally {
        await setTriggers(scratch, 'DISABLE');
      }
      expect(await journalTriggers(scratch)).toEqual(allStates('D'));
    });
  });

  describe('P5. function identity', () => {
    it('keeps signature, result, language, owner, ACL, SECURITY and settings; only the body changes', async () => {
      expect(previousShape).toMatchObject({
        identity: 'activate_adherence_history_origin()',
        definer: false,
        config: ['search_path=pg_catalog'],
      });
      expect(await functionShape(scratch)).toEqual(previousShape);
      expect(await functionShape(main)).toEqual(previousShape);
      expect(await functionSource(scratch)).not.toBe(previousSource);
      expect(await functionSource(scratch)).toBe(await functionSource(main));
    });
  });

  describe('P6. lock timeout', () => {
    it('gives up after its 5 s lock_timeout on a busy covered table and changes nothing', () => {
      expect(busyMigration.code).toBe('55P03');
      expect(busyMigration.elapsed).toBeGreaterThanOrEqual(4500);
      expect(busyMigration.elapsed).toBeLessThan(15000);
      expect(busyMigration.triggers).toEqual(allStates('O'));
      expect(busyMigration.source).toBe(previousSource);
    });
  });

  describe('P7. mutual exclusion with the supported history operator', () => {
    it('uses the exact advisory lock taken by the operator before activation', () => {
      const operator = readFileSync(OPERATOR, 'utf8');
      expect(operator).toContain(
        `client.query('${OPERATOR_LOCK_SQL}', [${OPERATOR_LOCK.join(', ')}])`,
      );
      expect(migrationSql(TARGET)).toContain(
        `pg_catalog.pg_try_advisory_xact_lock(${OPERATOR_LOCK.join(', ')})`,
      );
    });

    it('an operator arriving while the migration waits for its locks cannot open an epoch with the triggers disabled', () => {
      expect(inFlight).toEqual({
        operatorLocked: false,
        migrationCode: undefined,
        activation: 'not started',
        newEpochs: 0,
        triggers: allStates('D'),
      });
    });

    it('fails fast and changes nothing while the operator holds its lock', () => {
      const { elapsed, ...outcome } = operatorHeld;
      expect(outcome).toEqual({
        code: '55P03',
        message:
          'Adherence history operator running (advisory lock 60309,31 held); retry after it ends',
        triggers: allStates('O'),
        source: 'unchanged',
      });
      expect(elapsed).toBeLessThan(4500);
    });
  });
});
