import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool, PoolClient } from 'pg';
import { assertTestDatabase } from '../../../scripts/test-database.cjs';

const SOURCES = {
  catalog_colors: true,
  diet_groups: true,
  diets: true,
  exercises: true,
  ingredients: true,
  meal_ingredients: true,
  meals: true,
  plan_assignment_trainings: true,
  plan_assignments: true,
  training_blocks: true,
  training_exercises: true,
  training_groups: true,
  trainings: true,
} as const;
type Source = keyof typeof SOURCES;
const sources = Object.keys(SOURCES) as Source[];
interface Image {
  id: string;
  [column: string]: unknown;
}
interface Baseline {
  source_table: Source;
  row_key: string;
  row_image: Image;
}
const migration = resolve(
  __dirname,
  '../../../prisma/migrations/20261001040000_adherence_history_baseline/migration.sql',
);

// Every case clones an OWN legacy84 DB; never drop or mutate shared test objects.
describe('coherent initial history epoch on PostgreSQL', () => {
  let root: Pool;
  let pool: Pool;
  const ids = new Map<string, string>();
  const id = (key: string) => {
    if (!ids.has(key)) ids.set(key, randomUUID());
    return ids.get(key)!;
  };
  beforeAll(async () => {
    if (
      process.env.P4_HISTORY_NONCE !== '7f814563-7e91-42ac-a869-4e9470a32d81' ||
      process.env.P4_HISTORY_LEGACY_DATABASE !==
        'exom_ci_history_legacy_7f814563'
    )
      throw new Error('Own history launcher required');
    const aliases = [
      'TEST_DATABASE_URL',
      'DATABASE_URL',
      'PRISMA_DATABASE_URL',
      'DIRECT_URL',
    ].map((key) => process.env[key]);
    if (!aliases[0] || !aliases.every((value) => value === aliases[0]))
      throw new Error('Own aliases must match');
    root = new Pool({ connectionString: aliases[0], ssl: false });
    await assertTestDatabase(root);
    const { rows } = await root.query<{ stamps: string }>(
      "SELECT current_setting('track_commit_timestamp') stamps",
    );
    expect(rows[0].stamps).toBe('off');
  });
  beforeEach(async () => {
    ids.clear();
    const name = `exom_ci_history_${randomUUID().replaceAll('-', '')}`;
    await root.query(
      `CREATE DATABASE ${name} TEMPLATE exom_ci_history_legacy_7f814563`,
    );
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.pathname = `/${name}`;
    pool = new Pool({
      connectionString: url.toString(),
      ssl: false,
      max: 6,
      statement_timeout: 15000,
    });
    const identity = await pool.query<{
      db: string;
      role: string;
      dir: string;
    }>(
      "SELECT current_database() db,current_user role,current_setting('data_directory') dir",
    );
    expect(identity.rows[0]).toEqual({
      db: name,
      role: 'exom_ci',
      dir: '/var/lib/postgresql/exom-ci-data',
    });
    await seed();
  }, 20000);
  afterEach(async () => {
    await pool?.end();
  });
  afterAll(async () => {
    await root?.end();
  });
  async function seed() {
    const statements: [string, string[]][] = [
      [
        `INSERT INTO users(id,email,firebase_uid,updated_at) VALUES ($1,$2,$1,now())`,
        [id('user'), `${id('user')}@example.test`],
      ],
      [
        `INSERT INTO training_groups(id,name,normalized_name,updated_at) VALUES ($1,'Synthetic',$1,now())`,
        [id('training_groups')],
      ],
      [
        `INSERT INTO diet_groups(id,name,normalized_name,updated_at) VALUES ($1,'Synthetic',$1,now())`,
        [id('diet_groups')],
      ],
      [
        `INSERT INTO catalog_colors(id,catalog_type,normalized_key,value,color,updated_at) VALUES ($1,'training_type',$1,'TEST','#abcdef',now())`,
        [id('catalog_colors')],
      ],
      [
        `INSERT INTO trainings(id,name,type,types,tags,group_id,updated_at) VALUES ($1,'Synthetic','TEST',ARRAY['TEST'],'{}',$2,now())`,
        [id('trainings'), id('training_groups')],
      ],
      [
        `INSERT INTO exercises(id,name,muscle_groups,equipment,updated_at) VALUES ($1,'Synthetic',ARRAY['TEST'],ARRAY['TEST'],now())`,
        [id('exercises')],
      ],
      [
        `INSERT INTO training_blocks(id,training_id,"order",rounds,updated_at) VALUES ($1,$2,0,3,now())`,
        [id('training_blocks'), id('trainings')],
      ],
      [
        `INSERT INTO training_exercises(id,training_id,exercise_id,block_id,"order",sets,reps_or_duration,measure_type,target_value_min,target_value_max,target_rir,timed_config) VALUES ($1,$2,$3,$4,0,3,'8-12','REPS',8,12,3,NULL)`,
        [
          id('training_exercises'),
          id('trainings'),
          id('exercises'),
          id('training_blocks'),
        ],
      ],
      [
        `INSERT INTO diets(id,name,tags,total_calories,total_protein_g,total_carbs_g,total_fat_g,group_id,updated_at) VALUES ($1,'Synthetic','{}',1800,130,200,60,$2,now())`,
        [id('diets'), id('diet_groups')],
      ],
      [
        `INSERT INTO meals(id,diet_id,type,name,nutritional_badges,calories,protein_g,carbs_g,fat_g,updated_at) VALUES ($1,$2,'BREAKFAST','Synthetic','{}',400,30,50,10,now())`,
        [id('meals'), id('diets')],
      ],
      [
        `INSERT INTO meals(id,diet_id,parent_meal_id,type,name,nutritional_badges,calories,protein_g,carbs_g,fat_g,updated_at) VALUES ($1,$2,$3,'BREAKFAST','Alternative','{}',450,35,55,12,now())`,
        [id('alternative'), id('diets'), id('meals')],
      ],
      [
        `INSERT INTO ingredients(id,name,calories_per_100g,protein_per_100g,carbs_per_100g,fat_per_100g,updated_at) VALUES ($1,'Shared synthetic',300,20,40,10,now())`,
        [id('ingredients')],
      ],
      [
        `INSERT INTO meal_ingredients(id,meal_id,ingredient_id,quantity,grams_equivalent) VALUES ($1,$2,$3,100,95),($4,$5,$3,150,145)`,
        [
          id('meal_ingredients'),
          id('meals'),
          id('ingredients'),
          id('alternative_ingredient'),
          id('alternative'),
        ],
      ],
      [
        `INSERT INTO plan_assignments(id,client_id,date,diet_id,updated_at) VALUES ($1,$2,'2099-01-01',$3,now())`,
        [id('plan_assignments'), id('user'), id('diets')],
      ],
      [
        `INSERT INTO plan_assignment_trainings(id,assignment_id,training_id,position,last_set_video_policy) VALUES ($1,$2,$3,0,'NEVER')`,
        [
          id('plan_assignment_trainings'),
          id('plan_assignments'),
          id('trainings'),
        ],
      ],
    ];
    for (const [sql, values] of statements) await pool.query(sql, values);
  }
  async function state(): Promise<Baseline[]> {
    const result: Baseline[] = [];
    for (const table of sources) {
      const rows = await pool.query<Baseline>(
        `SELECT '${table}' source_table,id row_key,to_jsonb(s) row_image FROM public.${table} s ORDER BY id`,
      );
      expect(rows.rowCount).toBeGreaterThan(0);
      result.push(...rows.rows);
    }
    return result;
  }
  function sameImages(actual: Baseline[], expected: Baseline[]) {
    // Compare every JSON field without dumping private row images on failure.
    const keyed = (rows: Baseline[]) =>
      new Map(rows.map((row) => [`${row.source_table}:${row.row_key}`, row]));
    const a = keyed(actual);
    const e = keyed(expected);
    expect(a.size).toBe(e.size);
    expect(
      [...e].every(
        ([key, row]) => JSON.stringify(a.get(key)) === JSON.stringify(row),
      ),
    ).toBe(true);
  }
  async function bootstrap() {
    // RED is a real missing epoch after meaningful source DML, not module loading.
    if (!existsSync(migration))
      return pool.query('SELECT * FROM public.adherence_history_epochs');
    return pool.query(readFileSync(migration, 'utf8'));
  }
  async function baseline() {
    return (
      await pool.query<Baseline>(
        'SELECT source_table,row_key,row_image FROM public.adherence_history_baselines ORDER BY source_table,row_key',
      )
    ).rows;
  }
  it('captures full preexisting graph after untimed and bulk membership/diet edits', async () => {
    await pool.query(
      'UPDATE training_exercises SET sets=5,target_rir=1 WHERE training_id=$1',
      [id('trainings')],
    );
    await pool.query(
      'UPDATE plan_assignment_trainings SET position=position+1 WHERE assignment_id=$1',
      [id('plan_assignments')],
    );
    await pool.query('UPDATE diets SET total_calories=2200 WHERE id=$1', [
      id('diets'),
    ]);
    const before = await state();
    expect(new Set(before.map((row) => row.source_table)).size).toBe(13);
    await bootstrap();
    sameImages(await baseline(), before);
  });

  async function blocked(waiter: number, holder: number) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const result = await pool.query<{ pids: number[] }>(
        'SELECT pg_blocking_pids($1) pids',
        [waiter],
      );
      if (result.rows[0].pids.includes(holder)) return;
      await new Promise((done) => setTimeout(done, 20));
    }
    throw new Error('Expected actual PostgreSQL blocking PID not observed');
  }
  async function pid(client: PoolClient) {
    return (await client.query<{ pid: number }>('SELECT pg_backend_pid() pid'))
      .rows[0].pid;
  }
  function sql() {
    return readFileSync(migration, 'utf8');
  }
  async function historyAbsent() {
    const result = await pool.query<{ e: string | null; b: string | null }>(
      "SELECT to_regclass('public.adherence_history_epochs') e,to_regclass('public.adherence_history_baselines') b",
    );
    expect(result.rows[0]).toEqual({ e: null, b: null });
  }
  it('drains an inflight membership and catalog writer before fresh capture', async () => {
    const writer = await pool.connect();
    const capture = await pool.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await writer.query('BEGIN');
      await writer.query(
        'UPDATE plan_assignment_trainings SET position=2 WHERE id=$1',
        [id('plan_assignment_trainings')],
      );
      await writer.query('UPDATE diets SET total_calories=2300 WHERE id=$1', [
        id('diets'),
      ]);
      const writerPid = await pid(writer);
      const capturePid = await pid(capture);
      pending = capture.query(sql());
      await blocked(capturePid, writerPid);
      await writer.query('COMMIT');
      await pending;
      sameImages(await baseline(), await state());
    } finally {
      await writer.query('ROLLBACK');
      await pending?.catch(() => undefined);
      await capture.query('ROLLBACK');
      writer.release();
      capture.release();
    }
  });
  it('holds competing writers until commit and allocates all 13 sources after the boundary', async () => {
    const capture = await pool.connect();
    const writer = await pool.connect();
    let pending: Promise<unknown> | undefined;
    try {
      const before = await state();
      // Leave the actual migration transaction open at its final COMMIT boundary.
      await capture.query(sql().replace(/COMMIT;\s*$/, ''));
      const boundary = (
        await capture.query<{ sequence_boundary: string }>(
          'SELECT sequence_boundary FROM public.adherence_history_epochs',
        )
      ).rows[0].sequence_boundary;
      const capturePid = await pid(capture);
      const writerPid = await pid(writer);
      pending = writer.query(
        "UPDATE catalog_colors SET color='#123456' WHERE id=$1",
        [id('catalog_colors')],
      );
      await blocked(writerPid, capturePid);
      await capture.query('COMMIT');
      await pending;
      sameImages(await baseline(), before);
      // Existing producers unchanged: no-op source UPDATEs still capture full rows.
      for (const table of sources)
        await pool.query(`UPDATE public.${table} SET id=id`);
      const events = await pool.query<{
        event_sequence: string;
        source_table: Source;
        transaction_id: string;
      }>(
        `SELECT event_sequence,source_table,transaction_id FROM public.adherence_assignment_journal WHERE event_sequence>$1
         UNION ALL SELECT event_sequence,source_table,transaction_id FROM public.adherence_catalog_journal WHERE event_sequence>$1`,
        [boundary],
      );
      expect(new Set(events.rows.map((e) => e.source_table)).size).toBe(13);
      expect(
        events.rows.every(
          (e) =>
            BigInt(e.event_sequence) > BigInt(boundary) &&
            /^\d+$/.test(e.transaction_id),
        ),
      ).toBe(true);
      expect(new Set(events.rows.map((e) => e.event_sequence)).size).toBe(
        events.rows.length,
      );
    } finally {
      await capture.query('ROLLBACK');
      await pending?.catch(() => undefined);
      await writer.query('ROLLBACK');
      capture.release();
      writer.release();
    }
  });
  it('aborts on bounded lock timeout, preserves preceding events, and retries atomically', async () => {
    const writer = await pool.connect();
    const capture = await pool.connect();
    try {
      const preceding = (
        await pool.query(
          'SELECT * FROM public.adherence_catalog_journal ORDER BY event_sequence',
        )
      ).rows;
      await writer.query('BEGIN');
      await writer.query('UPDATE diets SET total_calories=2400 WHERE id=$1', [
        id('diets'),
      ]);
      const writerPid = await pid(writer);
      const capturePid = await pid(capture);
      const started = Date.now();
      const failed = capture.query(sql()).then(
        () => {
          throw new Error('Lock timeout expected');
        },
        (error: unknown) => error,
      );
      await blocked(capturePid, writerPid);
      const error = await failed;
      expect(error).toMatchObject({ code: '55P03' });
      expect(Date.now() - started).toBeGreaterThanOrEqual(4500);
      await capture.query('ROLLBACK');
      await historyAbsent();
      expect(
        JSON.stringify(
          (
            await pool.query(
              'SELECT * FROM public.adherence_catalog_journal ORDER BY event_sequence',
            )
          ).rows,
        ),
      ).toBe(JSON.stringify(preceding));
      await writer.query('COMMIT');
      await bootstrap();
      sameImages(await baseline(), await state());
    } finally {
      await writer.query('ROLLBACK');
      await capture.query('ROLLBACK');
      writer.release();
      capture.release();
    }
  }, 15000);
  it('rolls back created tables and images on a late capture failure then retries', async () => {
    const capture = await pool.connect();
    try {
      // Failure AFTER all INSERT SELECTs, before append-only installation/commit.
      const invalid = sql().replace(
        'CREATE FUNCTION public.reject_adherence_history_mutation()',
        'SELECT 1/0;\nCREATE FUNCTION public.reject_adherence_history_mutation()',
      );
      await expect(capture.query(invalid)).rejects.toMatchObject({
        code: '22012',
      });
      await capture.query('ROLLBACK');
      await historyAbsent();
      await bootstrap();
      expect(
        (
          await pool.query<{ n: number }>(
            'SELECT count(*)::int n FROM public.adherence_history_epochs',
          )
        ).rows[0].n,
      ).toBe(1);
      sameImages(await baseline(), await state());
    } finally {
      await capture.query('ROLLBACK');
      capture.release();
    }
  });
  it('enforces private owner-only append-only storage while existing restricted source writes work', async () => {
    await bootstrap();
    const role = `history_writer_${randomUUID().replaceAll('-', '')}`;
    await pool.query(
      `CREATE ROLE ${role} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
    );
    await pool.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await pool.query(`GRANT SELECT,UPDATE ON public.catalog_colors TO ${role}`);
    await pool.query(
      `CREATE POLICY ${role} ON public.catalog_colors TO ${role} USING (true) WITH CHECK (true)`,
    );
    const client = await pool.connect();
    try {
      await client.query(`SET ROLE ${role}`);
      for (const table of [
        'adherence_history_epochs',
        'adherence_history_baselines',
      ]) {
        for (const statement of [
          `SELECT * FROM public.${table}`,
          `INSERT INTO public.${table} DEFAULT VALUES`,
          `UPDATE public.${table} SET ${table.endsWith('epochs') ? 'id=id' : 'row_key=row_key'}`,
          `DELETE FROM public.${table}`,
          `TRUNCATE public.${table}`,
        ])
          await expect(client.query(statement)).rejects.toMatchObject({
            code: '42501',
          });
      }
      expect(
        (
          await client.query(
            "UPDATE public.catalog_colors SET color='#112233' WHERE id=$1",
            [id('catalog_colors')],
          )
        ).rowCount,
      ).toBe(1);
      await client.query('RESET ROLE');
      for (const table of [
        'adherence_history_epochs',
        'adherence_history_baselines',
      ])
        for (const statement of [
          `UPDATE public.${table} SET ${table.endsWith('epochs') ? 'id=id' : 'row_key=row_key'}`,
          `DELETE FROM public.${table}`,
          `TRUNCATE public.${table}${table.endsWith('epochs') ? ', public.adherence_history_baselines' : ''}`,
        ])
          await expect(client.query(statement)).rejects.toMatchObject({
            code: '55000',
          });
      const event = await pool.query<{ n: number }>(
        "SELECT count(*)::int n FROM public.adherence_catalog_journal WHERE source_table='catalog_colors' AND new_row->>'color'='#112233'",
      );
      expect(event.rows[0].n).toBe(1);
      expect(
        (await baseline()).find(
          (r) =>
            r.source_table === 'catalog_colors' &&
            r.row_key === id('catalog_colors'),
        )?.row_image.color,
      ).toBe('#abcdef');
      const metadata = await pool.query<{ private: boolean; owner: boolean }>(
        `SELECT c.relrowsecurity AND NOT c.relforcerowsecurity AS private,r.rolname=current_user AS owner FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE c.oid IN ('public.adherence_history_epochs'::regclass,'public.adherence_history_baselines'::regclass)`,
      );
      expect(metadata.rows).toEqual([
        { private: true, owner: true },
        { private: true, owner: true },
      ]);
    } finally {
      await client.query('RESET ROLE');
      client.release();
    }
  });
  it('captures coherently with NULL namespace when migration owner cannot read control functions', async () => {
    const before = await state();
    const role = `history_writer_${randomUUID().replaceAll('-', '')}`;
    await pool.query(
      `CREATE ROLE ${role} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
    );
    await pool.query(`GRANT USAGE,CREATE ON SCHEMA public TO ${role}`);
    for (const table of sources) {
      await pool.query(`ALTER TABLE public.${table} OWNER TO ${role}`);
      await pool.query(`GRANT SELECT,UPDATE ON public.${table} TO ${role}`);
      await pool.query(
        `CREATE POLICY ${role} ON public.${table} TO ${role} USING (true)`,
      );
    }
    for (const table of [
      'adherence_assignment_journal',
      'adherence_catalog_journal',
    ])
      await pool.query(`ALTER TABLE public.${table} OWNER TO ${role}`);
    const seq = (
      await pool.query<{ name: string }>(
        "SELECT pg_get_serial_sequence('public.adherence_assignment_journal','event_sequence') name",
      )
    ).rows[0].name;
    expect(seq).toMatch(/^public\.[a-z_]+$/);
    await pool.query(`ALTER SEQUENCE ${seq} OWNER TO ${role}`);
    for (const fn of [
      'capture_adherence_assignment_event',
      'capture_adherence_catalog_event',
    ])
      await pool.query(`ALTER FUNCTION public.${fn}() OWNER TO ${role}`);
    // Own child only: simulate a managed deployment restricting control metadata.
    await pool.query(
      'REVOKE EXECUTE ON FUNCTION pg_catalog.pg_control_system() FROM PUBLIC',
    );
    const client = await pool.connect();
    try {
      await client.query(`SET ROLE ${role}`);
      await expect(
        client.query('SELECT * FROM pg_catalog.pg_control_system()'),
      ).rejects.toMatchObject({ code: '42501' });
      await client.query(sql());
      const epoch = (
        await client.query<{
          source_system_identifier: string | null;
          source_timeline: number | null;
          source_database_oid: string | null;
        }>(
          'SELECT source_system_identifier,source_timeline,source_database_oid FROM public.adherence_history_epochs',
        )
      ).rows[0];
      expect(epoch).toEqual({
        source_system_identifier: null,
        source_timeline: null,
        source_database_oid: null,
      });
      sameImages(
        (
          await client.query<Baseline>(
            'SELECT source_table,row_key,row_image FROM public.adherence_history_baselines',
          )
        ).rows,
        before,
      );
    } finally {
      await client.query('ROLLBACK');
      await client.query('RESET ROLE');
      client.release();
    }
  });
  it('requires matching source owners instead of relying on potentially filtered RLS policies', async () => {
    const role = `history_writer_${randomUUID().replaceAll('-', '')}`;
    await pool.query(
      `CREATE ROLE ${role} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
    );
    await pool.query(`ALTER TABLE public.ingredients OWNER TO ${role}`);
    const client = await pool.connect();
    try {
      await expect(client.query(sql())).rejects.toMatchObject({
        code: '42501',
      });
      await client.query('ROLLBACK');
      await historyAbsent();
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
  it('stores full xid and real optional namespace, validates row keys and rejects non-source images', async () => {
    await bootstrap();
    const epoch = (
      await pool.query<{
        id: string;
        activating_full_xid: string;
        source_system_identifier: string | null;
        source_timeline: number | null;
        source_database_oid: string | null;
        capture_observed_at: Date;
      }>('SELECT * FROM public.adherence_history_epochs')
    ).rows[0];
    expect(epoch.activating_full_xid).toMatch(/^\d+$/);
    const identity = (
      await pool.query<{ system: string; timeline: number; database: string }>(
        'SELECT c.system_identifier::text system,p.timeline_id timeline,d.oid::bigint::text database FROM pg_control_system() c,pg_control_checkpoint() p,pg_database d WHERE d.datname=current_database()',
      )
    ).rows[0];
    expect(epoch.source_system_identifier).toBe(identity.system);
    expect(epoch.source_timeline).toBe(identity.timeline);
    expect(epoch.source_database_oid).toBe(identity.database);
    expect(epoch.capture_observed_at).toBeInstanceOf(Date);
    // No xid32 cast: synthetic full-width value accepted without truncation.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO public.adherence_history_epochs(id,source_set_version,activating_full_xid,sequence_boundary,capture_observed_at) VALUES ($1,1,'18446744073709551615',999,clock_timestamp())`,
        [id('wide')],
      );
      expect(
        (
          await client.query<{ activating_full_xid: string }>(
            'SELECT activating_full_xid FROM public.adherence_history_epochs WHERE id=$1',
            [id('wide')],
          )
        ).rows[0].activating_full_xid,
      ).toBe('18446744073709551615');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    for (const [table, key, image] of [
      ['users', 'x', { id: 'x' }],
      ['trainings', 'x', { id: 'y' }],
      ['trainings', 'x', {}],
      ['trainings', 'x', []],
    ]) {
      await expect(
        pool.query(
          'INSERT INTO public.adherence_history_baselines(epoch_id,source_table,row_key,row_image) VALUES ($1,$2,$3,$4)',
          [epoch.id, table, key, JSON.stringify(image)],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    }
    const fks = (
      await pool.query<{ target: string }>(
        "SELECT confrelid::regclass::text target FROM pg_constraint WHERE conrelid='public.adherence_history_baselines'::regclass AND contype='f'",
      )
    ).rows;
    expect(fks).toEqual([{ target: 'adherence_history_epochs' }]);
  });
});
