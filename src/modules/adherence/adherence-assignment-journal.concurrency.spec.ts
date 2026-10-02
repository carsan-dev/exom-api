import { randomUUID } from 'node:crypto';
import { Pool, PoolClient } from 'pg';
import { assertTestDatabase } from '../../../scripts/test-database.cjs';

const SOURCE = {
  ASSIGNMENT: 'plan_assignments',
  LINK: 'plan_assignment_trainings',
} as const;
type Source = (typeof SOURCE)[keyof typeof SOURCE];
interface RowImage {
  id: string;
  [column: string]: unknown;
}
interface Event {
  event_sequence: string;
  transaction_id: string;
  source_table: Source;
  operation: string;
  old_row: RowImage | null;
  new_row: RowImage | null;
  observed_at: Date;
}
interface Fixture {
  user: string;
  parent: string;
  other: string;
  trainings: string[];
  links: string[];
}
type State = Map<string, RowImage>;

// Reverse row events, not a BEFORE-row membership snapshot. UPDATE must remove
// NEW's key first: otherwise an identity change leaves a ghost in the old state.
function reverse(state: State, events: Event[]): State {
  const result = new Map(state);
  for (const event of [...events].reverse()) {
    if (event.new_row) {
      result.delete(`${event.source_table}:${event.new_row.id}`);
    }
    if (event.old_row) {
      result.set(`${event.source_table}:${event.old_row.id}`, event.old_row);
    }
  }
  return result;
}

describe('assignment row journal on actual PostgreSQL tables', () => {
  let pool: Pool;
  let fixture: Fixture;
  const restrictedRole = `journal_writer_${randomUUID().replaceAll('-', '')}`;
  const hostileSchema = `journal_hostile_${randomUUID().replaceAll('-', '')}`;

  beforeAll(async () => {
    if (!process.env.TEST_DATABASE_URL) {
      throw new Error(
        'An explicitly guarded disposable PostgreSQL is required',
      );
    }
    pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      ssl: false,
      max: 6,
      statement_timeout: 10000,
    });
    await assertTestDatabase(pool);
    // Fixture-only permissions on an explicitly isolated server, never runtime grants.
    await pool.query(`CREATE ROLE ${restrictedRole} NOSUPERUSER NOCREATEDB
      NOCREATEROLE NOINHERIT NOBYPASSRLS`);
    await pool.query(`GRANT USAGE ON SCHEMA public TO ${restrictedRole}`);
    for (const table of Object.values(SOURCE)) {
      await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON public.${table}
        TO ${restrictedRole}`);
      await pool.query(`CREATE POLICY ${restrictedRole} ON public.${table}
        TO ${restrictedRole} USING (true) WITH CHECK (true)`);
    }
    // Existing invoker RIR triggers also require these specific dependencies.
    await pool.query(`GRANT SELECT ON public.rir_protected_days, public.day_progress,
      public.users, public.rir_cycle_versions, public.training_exercises,
      public.rir_day_targets TO ${restrictedRole}`);
    await pool.query(
      `GRANT INSERT, UPDATE ON public.rir_day_targets TO ${restrictedRole}`,
    );
    await pool.query(
      `CREATE SCHEMA ${hostileSchema} AUTHORIZATION ${restrictedRole}`,
    );
    await pool.query(`CREATE TABLE ${hostileSchema}.plan_assignments(id text)`);
    await pool.query(
      `ALTER TABLE ${hostileSchema}.plan_assignments OWNER TO ${restrictedRole}`,
    );
  });
  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    const prefix = `journal-${randomUUID()}`;
    fixture = {
      user: `${prefix}-user`,
      parent: `${prefix}-parent`,
      other: `${prefix}-other`,
      trainings: [0, 1, 2, 3].map((n) => `${prefix}-training-${n}`),
      links: [0, 1, 2].map((n) => `${prefix}-link-${n}`),
    };
    await pool.query(
      `INSERT INTO users(id,email,firebase_uid,updated_at)
       VALUES ($1,$2,$1,now())`,
      [fixture.user, `${prefix}@example.test`],
    );
    for (const id of fixture.trainings) {
      await pool.query(
        `INSERT INTO trainings(id,name,type,tags,updated_at)
         VALUES ($1,'Synthetic journal fixture','TEST','{}',now())`,
        [id],
      );
    }
    await pool.query(
      `INSERT INTO plan_assignments(id,client_id,date,notes,updated_at)
       VALUES ($1,$3,'2099-01-01','original',now()),
              ($2,$3,'2099-01-02','other',now())`,
      [fixture.parent, fixture.other, fixture.user],
    );
    for (let n = 0; n < 3; n++) {
      await pool.query(
        `INSERT INTO plan_assignment_trainings
         (id,assignment_id,training_id,position,last_set_video_policy)
         VALUES ($1,$2,$3,$4,'NEVER')`,
        [fixture.links[n], fixture.parent, fixture.trainings[n], n],
      );
    }
  });
  afterEach(async () => {
    // Only this test's synthetic identities; journal intentionally outlives them.
    await pool.query('DELETE FROM users WHERE id=$1', [fixture.user]);
    await pool.query('DELETE FROM trainings WHERE id=ANY($1::text[])', [
      fixture.trainings,
    ]);
  });

  async function events(xid: string): Promise<Event[]> {
    const result = await pool.query<Event>(
      `SELECT * FROM adherence_assignment_journal
       WHERE transaction_id=$1 ORDER BY event_sequence`,
      [xid],
    );
    return result.rows;
  }
  async function state(): Promise<State> {
    const result = await pool.query<{ source: Source; image: RowImage }>(
      `SELECT 'plan_assignments' AS source,to_jsonb(p) AS image
       FROM plan_assignments p WHERE client_id=$1
       UNION ALL
       SELECT 'plan_assignment_trainings',to_jsonb(l)
       FROM plan_assignment_trainings l JOIN plan_assignments p
         ON p.id=l.assignment_id WHERE p.client_id=$1`,
      [fixture.user],
    );
    return new Map(
      result.rows.map((row) => [`${row.source}:${row.image.id}`, row.image]),
    );
  }
  async function transaction(
    mutate: (connection: PoolClient) => Promise<void>,
    rollback = false,
  ): Promise<string> {
    const connection = await pool.connect();
    try {
      await connection.query('BEGIN');
      const result = await connection.query<{ xid: string }>(
        'SELECT pg_current_xact_id()::text AS xid',
      );
      await mutate(connection);
      await connection.query(rollback ? 'ROLLBACK' : 'COMMIT');
      return result.rows[0].xid;
    } finally {
      await connection.query('ROLLBACK');
      connection.release();
    }
  }
  function assertTransaction(rows: Event[], xid: string) {
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((row) => row.transaction_id))).toEqual(
      new Set([xid]),
    );
    expect(xid).toMatch(/^\d+$/);
    for (let n = 0; n < rows.length; n++) {
      expect(rows[n].observed_at).toBeInstanceOf(Date);
      if (n) {
        expect(BigInt(rows[n].event_sequence)).toBeGreaterThan(
          BigInt(rows[n - 1].event_sequence),
        );
      }
    }
  }

  async function restricted(
    mutate: (connection: PoolClient) => Promise<void>,
    rollback = false,
  ): Promise<string> {
    await assertTestDatabase(pool);
    return transaction(async (connection) => {
      await connection.query(`SET LOCAL ROLE ${restrictedRole}`);
      await mutate(connection);
    }, rollback);
  }

  it('captures permitted nonowner INSERT/UPDATE/DELETE with complete images on both sources', async () => {
    const before = await state();
    const parent = `${fixture.parent}-restricted`;
    const link = `${parent}-link`;
    const xid = await restricted(async (connection) => {
      const updated = await connection.query(
        `UPDATE public.plan_assignments SET notes='restricted' WHERE id=$1 RETURNING id`,
        [fixture.parent],
      );
      expect(updated.rowCount).toBe(1);
      const statements: [string, string[]][] = [
        [
          `INSERT INTO public.plan_assignments(id,client_id,date,updated_at)
          VALUES ($1,$2,'2099-01-05',now()) RETURNING id`,
          [parent, fixture.user],
        ],
        [
          `INSERT INTO public.plan_assignment_trainings(id,assignment_id,training_id,position)
          VALUES ($1,$2,$3,0) RETURNING id`,
          [link, parent, fixture.trainings[3]],
        ],
        [
          `UPDATE public.plan_assignment_trainings SET last_set_video_policy='NEVER'
          WHERE id=$1 RETURNING id`,
          [link],
        ],
        [
          'DELETE FROM public.plan_assignment_trainings WHERE id=$1 RETURNING id',
          [link],
        ],
        [
          'DELETE FROM public.plan_assignments WHERE id=$1 RETURNING id',
          [parent],
        ],
      ];
      for (const [sql, parameters] of statements) {
        expect((await connection.query(sql, parameters)).rowCount).toBe(1);
      }
    });
    const rows = await events(xid);
    assertTransaction(rows, xid);
    // Six caller mutations plus two legacy mirror updates, all captured atomically.
    expect(rows).toHaveLength(8);
    for (const source of Object.values(SOURCE)) {
      for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
        expect(
          rows.some(
            (row) => row.source_table === source && row.operation === operation,
          ),
        ).toBe(true);
      }
      const original = before.get(
        `${source}:${source === SOURCE.ASSIGNMENT ? fixture.parent : fixture.links[0]}`,
      );
      for (const row of rows.filter((event) => event.source_table === source)) {
        for (const image of [row.old_row, row.new_row]) {
          if (image)
            expect(Object.keys(image).sort()).toEqual(
              Object.keys(original ?? {}).sort(),
            );
        }
      }
    }
    expect(reverse(await state(), rows)).toEqual(before);
  });

  it('rolls back a restricted source mutation and its journal on subsequent failure', async () => {
    const before = await state();
    let xid = '';
    await expect(
      restricted(async (connection) => {
        xid = (
          await connection.query<{ xid: string }>(
            'SELECT pg_current_xact_id()::text AS xid',
          )
        ).rows[0].xid;
        expect(
          (
            await connection.query(
              `UPDATE public.plan_assignments SET notes='rollback'
        WHERE id=$1 RETURNING id`,
              [fixture.parent],
            )
          ).rowCount,
        ).toBe(1);
        await connection.query('SELECT 1/0');
      }),
    ).rejects.toMatchObject({ code: '22012' });
    expect(await events(xid)).toEqual([]);
    expect(await state()).toEqual(before);
  });

  it('denies direct journal access, sequence use, execution and hostile trigger attachment', async () => {
    for (const sql of [
      'SELECT * FROM public.adherence_assignment_journal',
      `INSERT INTO public.adherence_assignment_journal(source_table,operation,new_row)
        VALUES ('plan_assignments','INSERT','{"id":"forged"}')`,
      'UPDATE public.adherence_assignment_journal SET operation=operation',
      'DELETE FROM public.adherence_assignment_journal',
      'TRUNCATE public.adherence_assignment_journal',
      "SELECT nextval('public.adherence_assignment_journal_event_sequence_seq')",
      'SELECT public.capture_adherence_assignment_event()',
    ]) {
      await expect(
        restricted(async (connection) => {
          await connection.query(sql);
        }),
      ).rejects.toMatchObject({ code: '42501' });
    }
    await expect(
      restricted(async (connection) => {
        await connection.query(`CREATE TRIGGER forged AFTER INSERT ON ${hostileSchema}.plan_assignments
        FOR EACH ROW EXECUTE FUNCTION public.capture_adherence_assignment_event()`);
      }),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('gates foreign-schema and same-schema spoof OIDs even for owner-attached triggers', async () => {
    const xid = await transaction(async (connection) => {
      await connection.query(`CREATE TRIGGER forged_owner AFTER INSERT ON ${hostileSchema}.plan_assignments
        FOR EACH ROW EXECUTE FUNCTION public.capture_adherence_assignment_event()`);
      await connection.query(`CREATE TABLE public.${hostileSchema}(id text)`);
      await connection.query(`CREATE TRIGGER forged_oid AFTER INSERT ON public.${hostileSchema}
        FOR EACH ROW EXECUTE FUNCTION public.capture_adherence_assignment_event()`);
    });
    expect(await events(xid)).toEqual([]);
    for (const table of [
      `${hostileSchema}.plan_assignments`,
      `public.${hostileSchema}`,
    ]) {
      await expect(
        transaction(async (connection) => {
          await connection.query(`INSERT INTO ${table} VALUES ('forged')`);
        }),
      ).rejects.toMatchObject({ code: '42501' });
      expect((await pool.query(`SELECT * FROM ${table}`)).rowCount).toBe(0);
    }
  });

  it('retains the migration journal owner, fixed search path and no bypass role grants', async () => {
    const result = await pool.query(`SELECT p.prosecdef, p.proconfig,
      p.proowner=c.relowner AS journal_owner, r.rolname=current_user AS migration_owner,
      has_function_privilege(current_user,p.oid,'EXECUTE') AS owner_execute
      FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
      JOIN pg_class c ON c.oid='public.adherence_assignment_journal'::regclass
      WHERE p.oid='public.capture_adherence_assignment_event()'::regprocedure`);
    expect(result.rows[0]).toMatchObject({
      prosecdef: true,
      proconfig: ['search_path=pg_catalog'],
      journal_owner: true,
      migration_owner: true,
      owner_execute: true,
    });
    const role = await pool.query(
      `SELECT rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolbypassrls
      FROM pg_roles WHERE rolname=$1`,
      [restrictedRole],
    );
    expect(role.rows[0]).toEqual({
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolinherit: false,
      rolbypassrls: false,
    });
  });

  it('reconstructs all three pretransaction links after a full SQL bulk delete', async () => {
    const before = await state();
    const xid = await transaction(async (connection) => {
      await connection.query(
        'DELETE FROM plan_assignment_trainings WHERE assignment_id=$1',
        [fixture.parent],
      );
    });
    const rows = await events(xid);
    assertTransaction(rows, xid);
    expect(rows.filter((row) => row.source_table === SOURCE.LINK)).toHaveLength(
      3,
    );
    expect(reverse(await state(), rows)).toEqual(before);
  });

  it('captures direct SQL inserts, moves, link key changes and full parent updates', async () => {
    const before = await state();
    const xid = await transaction(async (connection) => {
      await connection.query(
        `INSERT INTO plan_assignment_trainings(id,assignment_id,training_id,position)
         VALUES ($1,$2,$3,3)`,
        [`${fixture.parent}-insert`, fixture.parent, fixture.trainings[3]],
      );
      await connection.query(
        'UPDATE plan_assignment_trainings SET assignment_id=$1,id=$2 WHERE id=$3',
        [fixture.other, `${fixture.links[1]}-moved`, fixture.links[1]],
      );
      await connection.query(
        `UPDATE plan_assignments SET notes='edited',is_rest_day=true,
         date='2099-01-03',updated_at=clock_timestamp() WHERE id=$1`,
        [fixture.parent],
      );
      // Parent key changes also cascade into the already-moved dependent link.
      await connection.query('UPDATE plan_assignments SET id=$1 WHERE id=$2', [
        `${fixture.other}-new`,
        fixture.other,
      ]);
    });
    const rows = await events(xid);
    assertTransaction(rows, xid);
    expect(rows.some((row) => row.operation === 'INSERT')).toBe(true);
    expect(rows.some((row) => row.old_row?.id !== row.new_row?.id)).toBe(true);
    expect(reverse(await state(), rows)).toEqual(before);
  });

  it('keeps complete OLD images through user and training FK cascades', async () => {
    const before = await state();
    const xid = await transaction(async (connection) => {
      await connection.query('DELETE FROM trainings WHERE id=$1', [
        fixture.trainings[0],
      ]);
      await connection.query('DELETE FROM users WHERE id=$1', [fixture.user]);
    });
    const rows = await events(xid);
    assertTransaction(rows, xid);
    expect(await state()).toEqual(new Map());
    expect(rows.filter((row) => row.source_table === SOURCE.LINK)).toHaveLength(
      3,
    );
    expect(reverse(await state(), rows)).toEqual(before);
    expect(
      rows
        .filter((row) => row.operation === 'DELETE')
        .every((row) => row.old_row !== null && row.new_row === null),
    ).toBe(true);
  });

  it('records full parent INSERT images and the corresponding links in one transaction', async () => {
    const before = await state();
    const parent = `${fixture.parent}-inserted`;
    const xid = await transaction(async (connection) => {
      await connection.query(
        `INSERT INTO plan_assignments(id,client_id,date,notes,updated_at)
         VALUES ($1,$2,'2099-01-04','insert payload',now())`,
        [parent, fixture.user],
      );
      await connection.query(
        `INSERT INTO plan_assignment_trainings(id,assignment_id,training_id,position)
         VALUES ($1,$2,$3,0)`,
        [`${parent}-link`, parent, fixture.trainings[3]],
      );
    });
    const rows = await events(xid);
    assertTransaction(rows, xid);
    const inserted = rows.find(
      (row) =>
        row.source_table === SOURCE.ASSIGNMENT && row.operation === 'INSERT',
    );
    const current = await state();
    // Subsequent mirror UPDATEs can change the parent after the original insert.
    expect(inserted?.old_row).toBeNull();
    expect(inserted?.new_row).toMatchObject({
      id: parent,
      notes: 'insert payload',
    });
    expect(Object.keys(inserted?.new_row ?? {}).sort()).toEqual(
      Object.keys(current.get(`${SOURCE.ASSIGNMENT}:${parent}`) ?? {}).sort(),
    );
    expect(reverse(current, rows)).toEqual(before);
  });

  it('rejects malformed operation shapes and ordinary journal mutation', async () => {
    const invalid = [
      ['INSERT', { id: 'old' }, { id: 'new' }],
      ['INSERT', null, null],
      ['UPDATE', null, { id: 'new' }],
      ['DELETE', { id: 'old' }, { id: 'new' }],
      ['OTHER', null, { id: 'new' }],
      ['INSERT', null, []],
    ];
    for (const [operation, oldRow, newRow] of invalid) {
      await expect(
        pool.query(
          `INSERT INTO adherence_assignment_journal(source_table,operation,old_row,new_row)
         VALUES ('plan_assignments',$1,$2::jsonb,$3::jsonb)`,
          [
            operation,
            oldRow === null ? null : JSON.stringify(oldRow),
            newRow === null ? null : JSON.stringify(newRow),
          ],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    }
    await expect(
      pool.query(
        `INSERT INTO adherence_assignment_journal(source_table,operation,new_row)
       VALUES ('uncovered_catalog','INSERT','{"id":"invalid"}')`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
    for (const sql of [
      'UPDATE adherence_assignment_journal SET operation=operation WHERE false',
      'DELETE FROM adherence_assignment_journal WHERE false',
      'TRUNCATE adherence_assignment_journal',
    ]) {
      await expect(pool.query(sql)).rejects.toMatchObject({ code: '55000' });
    }
  });

  it('rolls back both source mutations and all journal events', async () => {
    const before = await state();
    const xid = await transaction(async (connection) => {
      await connection.query(
        'DELETE FROM plan_assignments WHERE client_id=$1',
        [fixture.user],
      );
      const visible = await connection.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM adherence_assignment_journal
         WHERE transaction_id=pg_current_xact_id()::text`,
      );
      expect(visible.rows[0].n).toBeGreaterThan(0);
    }, true);
    expect(await events(xid)).toEqual([]);
    expect(await state()).toEqual(before);
  });

  it('separates committed full transaction identities, not observation timestamps', async () => {
    const xids: string[] = [];
    for (const notes of ['first', 'second']) {
      xids.push(
        await transaction(async (connection) => {
          await connection.query(
            'UPDATE plan_assignments SET notes=$1 WHERE id=$2',
            [notes, fixture.parent],
          );
        }),
      );
    }
    expect(xids[0]).not.toBe(xids[1]);
    for (const xid of xids) assertTransaction(await events(xid), xid);
  });

  it('observes a concurrent FK insert blocked by replacement before preserving both transactions', async () => {
    const before = await state();
    const replacement = await pool.connect();
    const insertion = await pool.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await replacement.query('BEGIN');
      await insertion.query('BEGIN');
      const a = await replacement.query<{ xid: string; pid: number }>(
        'SELECT pg_current_xact_id()::text AS xid,pg_backend_pid() AS pid',
      );
      const b = await insertion.query<{ xid: string; pid: number }>(
        'SELECT pg_current_xact_id()::text AS xid,pg_backend_pid() AS pid',
      );
      await replacement.query(
        'SELECT id FROM plan_assignments WHERE id=$1 FOR UPDATE',
        [fixture.parent],
      );
      await replacement.query(
        'DELETE FROM plan_assignment_trainings WHERE assignment_id=$1',
        [fixture.parent],
      );
      pending = insertion.query(
        `INSERT INTO plan_assignment_trainings(id,assignment_id,training_id,position)
         VALUES ($1,$2,$3,0)`,
        [`${fixture.parent}-concurrent`, fixture.parent, fixture.trainings[3]],
      );
      // Attach a rejection handler immediately, but keep the original promise.
      void pending.catch(() => undefined);
      let blocked = false;
      for (let attempt = 0; attempt < 200; attempt++) {
        const result = await pool.query<{ blocked: boolean }>(
          'SELECT $2::int = ANY(pg_blocking_pids($1)) AS blocked',
          [b.rows[0].pid, a.rows[0].pid],
        );
        if (result.rows[0].blocked) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      await replacement.query('COMMIT');
      await pending;
      await insertion.query('COMMIT');
      const first = await events(a.rows[0].xid);
      const second = await events(b.rows[0].xid);
      assertTransaction(first, a.rows[0].xid);
      assertTransaction(second, b.rows[0].xid);
      expect(
        first.filter((row) => row.source_table === SOURCE.LINK),
      ).toHaveLength(3);
      expect(reverse(reverse(await state(), second), first)).toEqual(before);
    } finally {
      await replacement.query('ROLLBACK');
      await pending?.catch(() => undefined);
      await insertion.query('ROLLBACK');
      replacement.release();
      insertion.release();
    }
  }, 15000);
});
