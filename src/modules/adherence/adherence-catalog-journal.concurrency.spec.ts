import { randomUUID } from 'node:crypto';
import { Pool, PoolClient } from 'pg';
import { assertTestDatabase } from '../../../scripts/test-database.cjs';

// SQL identifiers below are fixed fixtures, never caller-supplied identifiers.
const SOURCES = {
  trainings: "name='Changed',is_active=false,estimated_duration_min=55",
  training_blocks: 'rounds=5,rest_between_rounds_seconds=120',
  training_exercises:
    "sets=5,target_rir=1,rest_seconds=30,measure_type='SECONDS',target_value=40,target_value_min=NULL,target_value_max=NULL,reps_or_duration='40',timed_config=NULL",
  exercises:
    "is_active=false,video_url='https://example.test/new',technique_text='changed'",
  training_groups: "name='Changed training group'",
  diet_groups: "name='Changed diet group'",
  catalog_colors: "color='#123456',value='changed'",
  diets: 'is_active=false,total_calories=2200,total_protein_g=155.5',
  meals: "name='Changed meal',protein_g=55,calories=600",
  meal_ingredients: "quantity=200,grams_equivalent=180,unit='g'",
  ingredients: 'is_active=false,calories_per_100g=444,protein_per_100g=33',
} as const;
type Source = keyof typeof SOURCES;
const tables = Object.keys(SOURCES) as Source[];
interface Image {
  id: string;
  [column: string]: unknown;
}
interface Event {
  event_sequence: string;
  transaction_id: string;
  source_table: string;
  operation: string;
  old_row: Image | null;
  new_row: Image | null;
  observed_at: Date;
}
interface Metadata {
  relrowsecurity: boolean;
  prosecdef: boolean;
  proconfig: string[];
  same_owner: boolean;
}
type State = Map<string, Image>;

function reverse(state: State, events: Event[]): State {
  const result = new Map(state);
  for (const event of [...events].reverse()) {
    if (event.new_row)
      result.delete(`${event.source_table}:${event.new_row.id}`);
    if (event.old_row)
      result.set(`${event.source_table}:${event.old_row.id}`, event.old_row);
  }
  return result;
}

describe('catalog row journal on actual PostgreSQL tables', () => {
  let pool: Pool;
  let prefix: string;
  let seedXid: string;
  const role = `catalog_writer_${randomUUID().replaceAll('-', '')}`;
  const hostile = `catalog_hostile_${randomUUID().replaceAll('-', '')}`;
  const id = (table: string) => `${prefix}-${table}`;
  beforeAll(async () => {
    if (!process.env.TEST_DATABASE_URL) throw new Error('Isolated DB required');
    pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      ssl: false,
      max: 6,
      statement_timeout: 10000,
    });
    await assertTestDatabase(pool);
    await pool.query(
      `CREATE ROLE ${role} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
    );
    await pool.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    for (const table of tables) {
      await pool.query(
        `GRANT SELECT,INSERT,UPDATE,DELETE ON public.${table} TO ${role}`,
      );
      await pool.query(
        `CREATE POLICY ${role} ON public.${table} TO ${role} USING (true) WITH CHECK (true)`,
      );
    }
    // Existing invoker RIR triggers: legitimate dependencies, no journal grants.
    await pool.query(`GRANT SELECT ON public.plan_assignments,public.plan_assignment_trainings,
      public.rir_protected_days,public.day_progress,public.users,public.rir_cycle_versions,
      public.rir_day_targets TO ${role}`);
    await pool.query(
      `GRANT INSERT,UPDATE ON public.rir_day_targets TO ${role}`,
    );
    // Deletion-reference fencing locks users; occurrence deletion preserves feedback.
    await pool.query(`GRANT UPDATE(id) ON public.users TO ${role}`);
    await pool.query(`GRANT SELECT ON public.client_deletions,public.feedback_media,
      public.training_day_snapshots TO ${role}`);
    await pool.query(
      `GRANT UPDATE(training_exercise_id) ON public.feedback_media TO ${role}`,
    );
    await pool.query(`CREATE SCHEMA ${hostile} AUTHORIZATION ${role}`);
    await pool.query(`CREATE TABLE ${hostile}.trainings(id text)`);
    await pool.query(`ALTER TABLE ${hostile}.trainings OWNER TO ${role}`);
  });
  afterAll(async () => {
    // Journals/fixtures retained until exclusive owned-server disposal.
    await pool?.end();
  });
  async function transaction(
    mutate: (c: PoolClient) => Promise<void>,
    rollback = false,
  ): Promise<string> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const xid = (
        await c.query<{ xid: string }>('SELECT pg_current_xact_id()::text xid')
      ).rows[0].xid;
      await mutate(c);
      await c.query(rollback ? 'ROLLBACK' : 'COMMIT');
      return xid;
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  }
  async function events(xid: string): Promise<Event[]> {
    return (
      await pool.query<Event>(
        `SELECT * FROM public.adherence_catalog_journal
      WHERE transaction_id=$1 ORDER BY event_sequence`,
        [xid],
      )
    ).rows;
  }
  async function state(): Promise<State> {
    const result: State = new Map();
    for (const table of tables) {
      const rows = await pool.query<{ image: Image }>(
        `SELECT to_jsonb(t) image FROM public.${table} t WHERE id LIKE $1`,
        [`${prefix}-%`],
      );
      for (const { image } of rows.rows)
        result.set(`${table}:${image.id}`, image);
    }
    return result;
  }
  beforeEach(async () => {
    prefix = `catalog-${randomUUID()}`;
    seedXid = await transaction(async (c) => {
      const statements: [string, unknown[]][] = [
        [
          `INSERT INTO training_groups(id,name,normalized_name,updated_at) VALUES ($1,'Synthetic',$1,now())`,
          [id('training_groups')],
        ],
        [
          `INSERT INTO diet_groups(id,name,normalized_name,updated_at) VALUES ($1,'Synthetic',$1,now())`,
          [id('diet_groups')],
        ],
        [
          `INSERT INTO trainings(id,name,type,types,tags,group_id,"accentColor",updated_at) VALUES ($1,'Synthetic','TEST',ARRAY['TEST'],'{}',$2,'#abcdef',now())`,
          [id('trainings'), id('training_groups')],
        ],
        [
          `INSERT INTO exercises(id,name,muscle_groups,equipment,video_url,video_stream_id,technique_text,updated_at) VALUES ($1,'Synthetic',ARRAY['TEST'],ARRAY['TEST'],'https://example.test/video','synthetic-stream','original',now())`,
          [id('exercises')],
        ],
        [
          `INSERT INTO training_blocks(id,training_id,"order",rounds,rest_between_rounds_seconds,updated_at) VALUES ($1,$2,0,3,60,now())`,
          [id('training_blocks'), id('trainings')],
        ],
        [
          `INSERT INTO training_exercises(id,training_id,exercise_id,block_id,"order",sets,reps_or_duration,measure_type,target_value,target_value_min,target_value_max,target_rir,rest_seconds,request_set_tracking,timed_config)
          VALUES ($1,$2,$3,$4,0,3,'8-12','REPS',NULL,8,12,3,90,true,NULL),($5,$2,$3,NULL,1,2,'30','SECONDS',30,NULL,NULL,2,45,false,'{"version":1,"unit":"SECONDS","segments":[{"action":"work","unit":"SECONDS","seconds":30}]}')`,
          [
            id('training_exercises'),
            id('trainings'),
            id('exercises'),
            id('training_blocks'),
            id('timed'),
          ],
        ],
        [
          `INSERT INTO catalog_colors(id,catalog_type,normalized_key,value,color,updated_at) VALUES ($1,'training_type',$1,'TEST','#abcdef',now())`,
          [id('catalog_colors')],
        ],
        [
          `INSERT INTO diets(id,name,tags,total_calories,total_protein_g,total_carbs_g,total_fat_g,group_id,updated_at) VALUES ($1,'Synthetic',ARRAY['TEST'],1800,130.5,200.5,60.5,$2,now())`,
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
            id('alt-ingredient'),
            id('alternative'),
          ],
        ],
      ];
      for (const [sql, values] of statements) await c.query(sql, values);
    });
  });

  it('preserves original untimed series through update and bulk replacement', async () => {
    const before = await state();
    const xid = await transaction(async (c) => {
      await c.query(
        'UPDATE training_exercises SET sets=5,target_rir=1 WHERE training_id=$1',
        [id('trainings')],
      );
      await c.query('DELETE FROM training_exercises WHERE training_id=$1', [
        id('trainings'),
      ]);
    });
    const rows = await events(xid);
    expect(rows).toHaveLength(4);
    expect(
      rows.find((e) => e.old_row?.id === id('training_exercises'))?.old_row,
    ).toEqual(before.get(`training_exercises:${id('training_exercises')}`));
    expect(reverse(await state(), rows)).toEqual(before);
  });

  it.each(tables)(
    'captures full INSERT/UPDATE/DELETE for restricted %s DML',
    async (table) => {
      const before = await state();
      const original = before.get(`${table}:${id(table)}`);
      const seed = (await events(seedXid)).find(
        (e) => e.new_row?.id === id(table),
      );
      expect(seed?.operation).toBe('INSERT');
      expect(seed?.old_row).toBeNull();
      expect(seed?.new_row).toEqual(original);
      let changed: Image | undefined;
      const xid = await transaction(async (c) => {
        await c.query(`SET LOCAL ROLE ${role}`);
        expect(
          (
            await c.query(
              `UPDATE public.${table} SET ${SOURCES[table]} WHERE id=$1`,
              [id(table)],
            )
          ).rowCount,
        ).toBe(1);
        changed = (
          await c.query<{ image: Image }>(
            `SELECT to_jsonb(t) image FROM public.${table} t WHERE id=$1`,
            [id(table)],
          )
        ).rows[0].image;
        // Shared ingredients/exercises use RESTRICT: remove referencing source rows.
        if (table === 'ingredients')
          await c.query('DELETE FROM meal_ingredients WHERE ingredient_id=$1', [
            id(table),
          ]);
        if (table === 'exercises')
          await c.query('DELETE FROM training_exercises WHERE exercise_id=$1', [
            id(table),
          ]);
        expect(
          (
            await c.query(`DELETE FROM public.${table} WHERE id=$1`, [
              id(table),
            ])
          ).rowCount,
        ).toBe(1);
        await c.query(
          `INSERT INTO public.${table} SELECT (jsonb_populate_record(NULL::public.${table},$1::jsonb)).*`,
          [JSON.stringify(changed)],
        );
      });
      const rows = (await events(xid)).filter(
        (e) => (e.old_row ?? e.new_row)?.id === id(table),
      );
      expect(rows.map((e) => e.operation)).toEqual([
        'UPDATE',
        'DELETE',
        'INSERT',
      ]);
      expect(rows[0].old_row).toEqual(original);
      expect(changed).toBeDefined();
      expect(rows[0].new_row).toEqual(changed);
      expect(rows[0].new_row).not.toEqual(original);
      expect(rows[1].old_row).toEqual(rows[0].new_row);
      expect(rows[1].new_row).toBeNull();
      expect(rows[2].old_row).toBeNull();
      expect(rows[2].new_row).toEqual(rows[0].new_row);
      expect(reverse(await state(), await events(xid))).toEqual(before);
    },
  );

  it('reverses combined key changes, parent moves, group SetNull and bulk cascades', async () => {
    const before = await state();
    const xid = await transaction(async (c) => {
      await c.query(
        `UPDATE training_exercises SET id=id||'-moved',block_id=NULL,"order"=9 WHERE id=$1`,
        [id('training_exercises')],
      );
      await c.query('UPDATE meals SET parent_meal_id=NULL WHERE id=$1', [
        id('alternative'),
      ]);
      await c.query('DELETE FROM training_groups WHERE id=$1', [
        id('training_groups'),
      ]);
      await c.query('DELETE FROM diet_groups WHERE id=$1', [id('diet_groups')]);
      await c.query('DELETE FROM trainings WHERE id=$1', [id('trainings')]);
      await c.query('DELETE FROM diets WHERE id=$1', [id('diets')]);
    });
    const rows = await events(xid);
    for (const source of ['trainings', 'diets']) {
      expect(
        rows.some(
          (e) =>
            e.source_table === source &&
            e.operation === 'UPDATE' &&
            e.new_row?.group_id === null,
        ),
      ).toBe(true);
    }
    expect(rows.filter((e) => e.operation === 'DELETE').length).toBeGreaterThan(
      8,
    );
    expect(reverse(await state(), rows)).toEqual(before);
  });

  it('does not invent history for the four colors installed before capture', async () => {
    const legacy = await pool.query<{ id: string }>(
      `SELECT id FROM catalog_colors WHERE catalog_type='training_type'
        AND normalized_key IN ('fuerza','cardio','hiit','flexibilidad')`,
    );
    expect(legacy.rowCount).toBe(4);
    const captured = await pool.query(
      `SELECT 1 FROM adherence_catalog_journal WHERE source_table='catalog_colors'
        AND (old_row->>'id'=ANY($1::text[]) OR new_row->>'id'=ANY($1::text[]))`,
      [legacy.rows.map((row) => row.id)],
    );
    expect(captured.rowCount).toBe(0);
    // UNKNOWN pre-capture provenance; this is not a bootstrap or epoch marker.
  });

  it('rolls back all journal events and source changes atomically', async () => {
    const before = await state();
    const xid = await transaction(async (c) => {
      await c.query(`SET LOCAL ROLE ${role}`);
      for (const table of tables)
        await c.query(
          `UPDATE public.${table} SET ${SOURCES[table]} WHERE id=$1`,
          [id(table)],
        );
    }, true);
    expect(await events(xid)).toEqual([]);
    expect(await state()).toEqual(before);
  });

  async function assignment(): Promise<void> {
    await pool.query(
      'INSERT INTO users(id,email,firebase_uid,updated_at) VALUES ($1,$2,$1,now())',
      [id('user'), `${prefix}@example.test`],
    );
    await pool.query(
      `INSERT INTO plan_assignments(id,client_id,date,training_id,diet_id,updated_at) VALUES ($1,$2,'2099-01-01',$3,$4,now())`,
      [id('assignment'), id('user'), id('trainings'), id('diets')],
    );
  }
  it('shares allocation sequence and xid across interleaved assignment/catalog changes', async () => {
    await assignment();
    const xid = await transaction(async (c) => {
      await c.query("UPDATE trainings SET name='first' WHERE id=$1", [
        id('trainings'),
      ]);
      await c.query("UPDATE plan_assignments SET notes='middle' WHERE id=$1", [
        id('assignment'),
      ]);
      await c.query('UPDATE diets SET total_calories=2000 WHERE id=$1', [
        id('diets'),
      ]);
    });
    const rows = (
      await pool.query<Event>(
        `SELECT * FROM adherence_catalog_journal WHERE transaction_id=$1
      UNION ALL SELECT * FROM adherence_assignment_journal WHERE transaction_id=$1 ORDER BY event_sequence`,
        [xid],
      )
    ).rows;
    expect(rows.map((e) => e.source_table)).toEqual([
      'trainings',
      'plan_assignments',
      'diets',
    ]);
    expect(new Set(rows.map((e) => e.transaction_id))).toEqual(new Set([xid]));
    expect(xid).toMatch(/^\d+$/);
    for (let n = 0; n < rows.length; n++) {
      expect(rows[n].observed_at).toBeInstanceOf(Date);
      if (n)
        expect(BigInt(rows[n].event_sequence)).toBeGreaterThan(
          BigInt(rows[n - 1].event_sequence),
        );
    }
  });

  it('observes actual catalog barrier blocking concurrent assignment UPDATE', async () => {
    await assignment();
    const a = await pool.connect();
    const b = await pool.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');
      const aPid = (
        await a.query<{ pid: number }>('SELECT pg_backend_pid() pid')
      ).rows[0].pid;
      const bPid = (
        await b.query<{ pid: number }>('SELECT pg_backend_pid() pid')
      ).rows[0].pid;
      const aXid = (
        await a.query<{ xid: string }>('SELECT pg_current_xact_id()::text xid')
      ).rows[0].xid;
      const bXid = (
        await b.query<{ xid: string }>('SELECT pg_current_xact_id()::text xid')
      ).rows[0].xid;
      await a.query("UPDATE trainings SET name='locked catalog' WHERE id=$1", [
        id('trainings'),
      ]);
      pending = b.query(
        "UPDATE plan_assignments SET notes='after barrier' WHERE id=$1",
        [id('assignment')],
      );
      const settled = pending.then(
        () => null,
        (error: unknown) => error,
      );
      let blocked = false;
      for (let n = 0; n < 100; n++) {
        const result = await pool.query<{ blockers: number[] }>(
          'SELECT pg_blocking_pids($1) blockers',
          [bPid],
        );
        if (result.rows[0].blockers.includes(aPid)) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      await a.query('COMMIT');
      expect(await settled).toBeNull();
      await b.query('COMMIT');
      expect((await events(aXid)).map((e) => e.source_table)).toEqual([
        'trainings',
      ]);
      expect(
        (
          await pool.query(
            'SELECT 1 FROM adherence_assignment_journal WHERE transaction_id=$1',
            [bXid],
          )
        ).rowCount,
      ).toBe(1);
    } finally {
      await a.query('ROLLBACK');
      if (pending) await pending.catch(() => undefined);
      await b.query('ROLLBACK');
      a.release();
      b.release();
    }
  });

  it('denies direct journal/sequence/function access, attachment and spoofed source OIDs', async () => {
    const denied = [
      'SELECT * FROM public.adherence_catalog_journal',
      `INSERT INTO public.adherence_catalog_journal(source_table,operation,new_row) VALUES ('trainings','INSERT','{"id":"forged"}')`,
      `SELECT nextval(pg_get_serial_sequence('public.adherence_assignment_journal','event_sequence'))`,
      'SELECT public.capture_adherence_catalog_event()',
      `CREATE TRIGGER forged AFTER INSERT ON ${hostile}.trainings FOR EACH ROW EXECUTE FUNCTION public.capture_adherence_catalog_event()`,
    ];
    for (const sql of denied) {
      await expect(
        transaction(async (c) => {
          await c.query(`SET LOCAL ROLE ${role}`);
          await c.query(sql);
        }),
      ).rejects.toMatchObject({ code: '42501' });
    }
    // Privileged attachment cannot defeat exact public source OID validation.
    await pool.query(
      `CREATE TRIGGER owner_forged_${prefix.replaceAll('-', '_')} AFTER INSERT ON ${hostile}.trainings FOR EACH ROW EXECUTE FUNCTION public.capture_adherence_catalog_event()`,
    );
    await expect(
      transaction(async (c) => {
        await c.query(`SET LOCAL ROLE ${role}`);
        await c.query(`INSERT INTO ${hostile}.trainings VALUES ('spoof')`);
      }),
    ).rejects.toMatchObject({ code: '42501' });
    expect(
      (await pool.query(`SELECT * FROM ${hostile}.trainings`)).rowCount,
    ).toBe(0);
  });

  it('enforces append-only DML, source/op/id shape checks and hardened metadata', async () => {
    for (const sql of [
      'UPDATE adherence_catalog_journal SET operation=operation',
      'DELETE FROM adherence_catalog_journal',
      'TRUNCATE adherence_catalog_journal',
    ]) {
      await expect(pool.query(sql)).rejects.toMatchObject({ code: '55000' });
    }
    for (const [source, op, old, next] of [
      ['users', 'INSERT', null, { id: 'x' }],
      ['trainings', 'UPDATE', null, { id: 'x' }],
      ['trainings', 'INSERT', null, { id: 4 }],
      ['trainings', 'DELETE', { no_id: 'x' }, null],
    ]) {
      await expect(
        pool.query(
          `INSERT INTO adherence_catalog_journal(source_table,operation,old_row,new_row) VALUES ($1,$2,$3,$4)`,
          [source, op, old, next],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    }
    const metadata = (
      await pool.query<Metadata>(`SELECT j.relrowsecurity,f.prosecdef,f.proconfig,j.relowner=f.proowner same_owner
      FROM pg_class j,pg_proc f WHERE j.oid='public.adherence_catalog_journal'::regclass AND f.oid='public.capture_adherence_catalog_event()'::regprocedure`)
    ).rows[0];
    expect(metadata).toMatchObject({
      relrowsecurity: true,
      prosecdef: true,
      same_owner: true,
      proconfig: ['search_path=pg_catalog'],
    });
    const attached = (
      await pool.query<{ table_name: Source }>(
        `SELECT c.relname table_name FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE t.tgfoid='public.capture_adherence_catalog_event()'::regprocedure AND n.nspname='public'`,
      )
    ).rows;
    expect(attached.map((r) => r.table_name).sort()).toEqual(
      [...tables].sort(),
    );
  });
});
