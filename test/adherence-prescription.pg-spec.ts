import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { Prisma } from '@prisma/client';
import {
  AdherencePrescriptionService,
  type PrescriptionPublisher,
  type StoredPrescription,
} from '../src/modules/adherence/adherence-prescription.service';
import type { AdherenceCommitSql } from '../src/modules/adherence/adherence-commit-resolver';
import type { AdherenceHistoryCutKey } from '../src/modules/adherence/adherence-history-cut';

class RawPromise<T> extends Promise<T> {
  get [Symbol.toStringTag]() {
    return 'PrismaPromise' as const;
  }
}
function sql(client: Pool | PoolClient): AdherenceCommitSql {
  return {
    $queryRaw<T = unknown>(
      query: TemplateStringsArray | Prisma.Sql,
      ...values: unknown[]
    ) {
      const statement = 'raw' in query ? Prisma.sql(query, ...values) : query;
      return new RawPromise<T>((resolve, reject) => {
        void client
          .query(statement.text, statement.values)
          .then((r) => resolve(r.rows as T), reject);
      });
    },
  };
}
function publisher(pool: Pool): PrescriptionPublisher {
  return {
    async withTransaction<T>(work: (db: AdherenceCommitSql) => Promise<T>) {
      const connection = await pool.connect();
      try {
        await connection.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        const result = await work(sql(connection));
        await connection.query('COMMIT');
        return result;
      } catch (error) {
        await connection.query('ROLLBACK');
        throw error;
      } finally {
        connection.release();
      }
    },
  };
}
const date = '2020-01-01';
const cutoff = '2020-01-02T00:00:00.000000Z';
const sources =
  'public.catalog_colors, public.diet_groups, public.diets, public.exercises, public.ingredients, public.meal_ingredients, public.meals, public.plan_assignment_trainings, public.plan_assignments, public.training_blocks, public.training_exercises, public.training_groups, public.trainings';

// Historical wall clock is explicitly a FIXTURE mapping of actual committed
// source transactions. These consumer tests do not claim real past activation
// or rerun the closed resolver/barrier clock guarantees of migrations82–88.
describe('historical prescription consumer on fresh owned PG17', () => {
  let pool: Pool;
  let service: AdherencePrescriptionService;
  const role = 'prescription_reader_' + randomUUID().replaceAll('-', '');
  async function fixture(covered = false) {
    const suffix = randomUUID();
    const client = 'c-' + suffix;
    const training = 't-' + suffix;
    const exercise = 'e-' + suffix;
    const assignment = 'a-' + suffix;
    const link = 'l-' + suffix;
    const occurrence = 'o-' + suffix;
    await pool.query(
      `INSERT INTO users(id,email,firebase_uid,updated_at) VALUES ($1,$2,$1,now());`,
      [client, client + '@example.test'],
    );
    await pool.query(
      `INSERT INTO trainings(id,name,type,tags,types,rir_proposal,updated_at) VALUES ($1,'Original','STRENGTH','{}',ARRAY['STRENGTH'],'[3,2]',now());`,
      [training],
    );
    await pool.query(
      `INSERT INTO exercises(id,name,muscle_groups,equipment,video_url,updated_at) VALUES ($1,'Squat','{}','{}','https://private.invalid/signed',now())`,
      [exercise],
    );
    await pool.query(
      `INSERT INTO training_exercises(id,training_id,exercise_id,"order",sets,reps_or_duration,measure_type,target_value_min,target_value_max,target_rir,request_set_tracking,rir_override) VALUES ($1,$2,$3,0,3,'8-12','REPS',8,12,3,true,'{"mode":"FIXED","value":2}')`,
      [occurrence, training, exercise],
    );
    await pool.query(
      `INSERT INTO plan_assignments(id,client_id,date,training_id,updated_at) VALUES ($1,$2,$3,$4,now())`,
      [assignment, client, date, training],
    );
    await pool.query(
      `INSERT INTO plan_assignment_trainings(id,assignment_id,training_id,position) VALUES ($1,$2,$3,0)`,
      [link, assignment, training],
    );
    let epochId: string;
    if (covered) {
      epochId = (
        await pool.query<{ id: string }>(
          'SELECT * FROM public.activate_adherence_history_origin()',
        )
      ).rows[0].id;
    } else {
      // Explicit original13 fixture, never retrofit coverage onto old epochs.
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query(`LOCK TABLE ${sources} IN SHARE ROW EXCLUSIVE MODE`);
        epochId = (
          await c.query<{ id: string }>(`INSERT INTO adherence_history_epochs
          (source_set_version, activating_full_xid, sequence_boundary, capture_observed_at)
          VALUES (1,pg_current_xact_id()::text,nextval(pg_get_serial_sequence('public.adherence_assignment_journal','event_sequence')),clock_timestamp()) RETURNING id`)
        ).rows[0].id;
        for (const source of sources.split(', ').map((s) => s.slice(7)))
          await c.query(
            `INSERT INTO adherence_history_baselines(epoch_id,source_table,row_key,row_image)
            SELECT $1,$2,id,to_jsonb(s) FROM public.${source} s`,
            [epochId, source],
          );
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      } finally {
        c.release();
      }
    }
    return {
      client,
      training,
      exercise,
      assignment,
      link,
      occurrence,
      epochId,
      origin: randomUUID(),
      cutoffUtc: cutoff,
    };
  }
  async function cut(
    key: AdherenceHistoryCutKey,
    afterXids: string[] = [],
    futureFixture = false,
  ) {
    const connection = await pool.connect();
    try {
      await connection.query('BEGIN');
      await connection.query(
        `LOCK TABLE ${sources}, public.diet_day_snapshots, public.rir_day_targets, public.training_day_snapshots IN SHARE ROW EXCLUSIVE MODE`,
      );
      const barrier = futureFixture
        ? (
            await connection.query<{
              value: { barrier_boundary: string; full_xids: string[] };
            }>(
              `WITH boundary AS MATERIALIZED (SELECT nextval(pg_get_serial_sequence('public.adherence_assignment_journal','event_sequence')) n)
           SELECT jsonb_build_object('barrier_boundary',n::text,'full_xids',public.adherence_cut_universe($1,n,128)) value FROM boundary`,
              [key.epochId],
            )
          ).rows[0].value
        : (
            await connection.query<{
              value: { barrier_boundary: string; full_xids: string[] };
            }>('SELECT public.begin_adherence_history_cut($1,$2,128) value', [
              key.epochId,
              key.cutoffUtc,
            ])
          ).rows[0].value;
      const before = '2020-01-01T23:59:59.999999Z';
      const after = '2020-01-02T00:00:00.000001Z';
      for (const xid of barrier.full_xids) {
        const content = (
          await connection.query<{ value: { content_digest: string } }>(
            'SELECT public.adherence_commit_payload($1,$2) value',
            [key.epochId, xid],
          )
        ).rows[0].value.content_digest;
        const timestamp = afterXids.includes(xid) ? after : before;
        await connection.query(
          `SELECT public.issue_adherence_commit_evidence($1,$2,$3,$4::text,
          (extract(epoch FROM $4::timestamptz)*1000000)::numeric(30,0)::text,$5)`,
          [key.epochId, key.origin, xid, timestamp, content],
        );
      }
      await connection.query(
        'SELECT public.issue_adherence_history_cut($1,$2,$3,$4::bigint)',
        [key.epochId, key.origin, key.cutoffUtc, barrier.barrier_boundary],
      );
      await connection.query('COMMIT');
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
  }
  async function published(
    f: Awaited<ReturnType<typeof fixture>>,
  ): Promise<StoredPrescription> {
    const result = await service.publish(f.client, date, f);
    expect(result.status).toBe('stored');
    if (result.status !== 'stored') throw new Error(JSON.stringify(result));
    expect(result.prescription.training.membership_basis).toBe('known');
    expect(result.prescription.training).not.toHaveProperty('basis');
    for (const unit of result.prescription.training.units) {
      expect(unit.effective_content.basis).toBe('unknown');
      expect(unit.effective_rir.basis).toBe('unknown');
      expect(unit.catalog_projection.authoritative).toBe(false);
      expect(unit).not.toHaveProperty('training');
    }
    return result;
  }
  async function blocked(waiter: number, blocker: number) {
    for (let i = 0; i < 200; i++) {
      const r = await pool.query<{ yes: boolean }>(
        'SELECT $2::int=ANY(pg_blocking_pids($1::int)) yes',
        [waiter, blocker],
      );
      if (r.rows[0].yes) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Forced blocking PID not observed');
  }
  beforeAll(() => {
    if (!process.env.EXOM_PRESCRIPTION_OWNED_RUN)
      throw new Error('Own identity-guarded launcher required');
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    service = new AdherencePrescriptionService(sql(pool), publisher(pool));
  });
  afterAll(() => pool?.end());

  it('captures actual committed DML from ALL three effective-reader sources', async () => {
    const f = await fixture();
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const xid = (
        await c.query<{ xid: string }>('SELECT pg_current_xact_id()::text xid')
      ).rows[0].xid;
      await c.query(
        `INSERT INTO diet_day_snapshots(client_id,date,diet_id,provenance,diet)
        VALUES ($1,$2,'overlay-diet','legacy_available','{"id":"overlay-diet","meals":[]}')`,
        [f.client, date],
      );
      await c.query(
        `INSERT INTO training_day_snapshots(client_id,date,training_id,payload)
        VALUES ($1,$2,$3,'{"id":"overlay-training","exercises":[],"blocks":[]}')`,
        [f.client, date, f.training],
      );
      await c.query(
        `INSERT INTO rir_day_targets(client_id,date,training_exercise_id,training_id,target_rir)
        VALUES ($1,$2,$3,$4,1)`,
        [f.client, date, f.occurrence, f.training],
      );
      await c.query('COMMIT');
      const journal = await pool.query<{
        source_table: string;
        new_row: Record<string, unknown>;
      }>(
        'SELECT source_table,new_row FROM adherence_catalog_journal WHERE transaction_id=$1 ORDER BY source_table',
        [xid],
      );
      expect(journal.rows.map((r) => r.source_table)).toEqual([
        'diet_day_snapshots',
        'rir_day_targets',
        'training_day_snapshots',
      ]);
      expect(journal.rows[1].new_row).toMatchObject({
        client_id: f.client,
        target_rir: 1,
      });
      expect(journal.rows[0].new_row).not.toHaveProperty('id');
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });
  it('new activation binds all existing overlays and marker; committed overlay replay yields sanitized known full content', async () => {
    const f = await fixture(true);
    const diet = f.client + '-diet16';
    const meal = diet + '-root';
    const variant = diet + '-alt';
    const ingredient = diet + '-ingredient';
    await pool.query(
      `INSERT INTO diets(id,name,total_calories,total_protein_g,updated_at) VALUES ($1,'Snapshot diet',1800,90,now())`,
      [diet],
    );
    await pool.query(
      `INSERT INTO meals(id,diet_id,type,name,nutritional_badges,"order",calories,protein_g,carbs_g,fat_g,updated_at)
      VALUES ($1,$2,'LUNCH','Root','{}',0,400,30,40,10,now()),($3,$2,'DINNER','Second required','{}',1,500,35,40,15,now())`,
      [meal, diet, meal + '-second'],
    );
    await pool.query(
      `INSERT INTO meals(id,diet_id,parent_meal_id,type,name,nutritional_badges,"order",calories,protein_g,carbs_g,fat_g,updated_at)
      VALUES ($1,$2,$3,'LUNCH','Alternative','{}',0,300,25,30,10,now())`,
      [variant, diet, meal],
    );
    await pool.query(
      `INSERT INTO ingredients(id,name,calories_per_100g,protein_per_100g,carbs_per_100g,fat_per_100g,updated_at)
      VALUES ($1,'Food',400,30,40,10,now())`,
      [ingredient],
    );
    await pool.query(
      `INSERT INTO meal_ingredients(id,meal_id,ingredient_id,quantity,unit) VALUES ($1,$2,$3,100,'g')`,
      [meal + '-link', meal, ingredient],
    );
    await pool.query('UPDATE plan_assignments SET diet_id=$1 WHERE id=$2', [
      diet,
      f.assignment,
    ]);
    await pool.query('SELECT public.exom_capture_diet_day($1,$2,$3)', [
      f.client,
      date,
      diet,
    ]);
    await pool.query('SELECT public.exom_capture_timed_day_for($1,$2,$3)', [
      f.client,
      date,
      f.training,
    ]);
    await pool.query(
      `INSERT INTO rir_day_targets(client_id,date,training_exercise_id,training_id,target_rir) VALUES ($1,$2,$3,$4,1)`,
      [f.client, date, f.occurrence, f.training],
    );
    // Catalog changes are separate, explicitly nonauthoritative under overlays.
    await pool.query(
      'UPDATE diets SET total_calories=2200,total_protein_g=120 WHERE id=$1',
      [diet],
    );
    await pool.query('UPDATE training_exercises SET target_rir=4 WHERE id=$1', [
      f.occurrence,
    ]);
    // Fresh activation must include already-existing legacy payloads, not only
    // new INSERT events. Its proof authenticates presence at this new cut.
    f.epochId = (
      await pool.query<{ id: string }>(
        'SELECT * FROM public.activate_adherence_history_origin()',
      )
    ).rows[0].id;
    const coverage = await pool.query<{ yes: boolean; n: number }>(
      `SELECT public.adherence_has_effective_coverage($1) yes,
      (SELECT count(*)::int FROM adherence_history_baselines WHERE epoch_id=$1 AND source_table IN ('diet_day_snapshots','training_day_snapshots','rir_day_targets')) n`,
      [f.epochId],
    );
    expect(coverage.rows[0].yes).toBe(true);
    expect(coverage.rows[0].n).toBeGreaterThanOrEqual(3);
    const snapshotImages = await pool.query(
      `SELECT b.row_image = to_jsonb(s) same FROM adherence_history_baselines b
      JOIN training_day_snapshots s ON b.row_key=public.adherence_effective_row_key('training_day_snapshots',to_jsonb(s))
      WHERE b.epoch_id=$1 AND b.source_table='training_day_snapshots'`,
      [f.epochId],
    );
    expect(snapshotImages.rows.every((r: { same: boolean }) => r.same)).toBe(
      true,
    );
    await cut(f);
    const original = await service.publish(f.client, date, f);
    expect(original).toMatchObject({
      status: 'stored',
      prescription: {
        training: {
          units: [
            {
              effective_content: {
                basis: 'known',
                training: { exercises: [{ target_rir: 1 }] },
              },
              effective_rir: { basis: 'known' },
              catalog_projection: {
                authoritative: false,
                exercises: [{ target_rir: 4 }],
              },
            },
          ],
        },
        nutrition: {
          basis: 'known',
          total_calories: 1800,
          total_protein_g: 90,
          groups: [
            {
              id: meal,
              alternatives: [
                {
                  id: meal,
                  ingredients: [
                    { quantity: 100, ingredient: { protein_per_100g: 30 } },
                  ],
                },
                { id: variant },
              ],
            },
            { id: meal + '-second' },
          ],
        },
      },
    });
    expect(JSON.stringify(original)).not.toMatch(
      /signed|video_url|captured_at|created_by|firebase|image_url/,
    );
    await pool.query('UPDATE diets SET total_calories=2500 WHERE id=$1', [
      diet,
    ]);
    await pool.query('UPDATE trainings SET name=$1 WHERE id=$2', [
      'Later',
      f.training,
    ]);
    expect(await service.read(f.client, date)).toEqual(original);
    expect(await service.publish(f.client, date, f)).toEqual(original);
  });
  it('replays committed three-source INSERTs after covered activation including cutoff exclusion', async () => {
    const f = await fixture(true);
    const c = await pool.connect();
    let xid: string;
    try {
      await c.query('BEGIN');
      xid = (
        await c.query<{ xid: string }>('SELECT pg_current_xact_id()::text xid')
      ).rows[0].xid;
      await c.query('SELECT public.exom_capture_timed_day_for($1,$2,$3)', [
        f.client,
        date,
        f.training,
      ]);
      await c.query(
        `INSERT INTO rir_day_targets(client_id,date,training_exercise_id,training_id,target_rir) VALUES ($1,$2,$3,$4,NULL)`,
        [f.client, date, f.occurrence, f.training],
      );
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    await cut(f, [xid]);
    const excluded = await service.publish(f.client, date, f);
    expect(excluded).toMatchObject({
      status: 'stored',
      prescription: {
        training: {
          units: [
            {
              effective_content: {
                basis: 'known',
                training: { exercises: [{ target_rir: 3 }] },
              },
            },
          ],
        },
      },
    });
    const g = await fixture(true);
    await pool.query('SELECT public.exom_capture_timed_day_for($1,$2,$3)', [
      g.client,
      date,
      g.training,
    ]);
    await pool.query(
      `INSERT INTO rir_day_targets(client_id,date,training_exercise_id,training_id,target_rir) VALUES ($1,$2,$3,$4,NULL)`,
      [g.client, date, g.occurrence, g.training],
    );
    await cut(g);
    expect(await service.publish(g.client, date, g)).toMatchObject({
      status: 'stored',
      prescription: {
        training: {
          units: [
            {
              effective_content: {
                basis: 'known',
                training: { exercises: [{ target_rir: null }] },
              },
            },
          ],
        },
      },
    });
  });
  it('uses cut-bound timed snapshot before day RIR while leaving catalog explicitly separate', async () => {
    const f = await fixture(true);
    await pool.query(
      `INSERT INTO training_day_snapshots(client_id,date,training_id,payload)
      SELECT $1,$2,t.id,to_jsonb(t) || jsonb_build_object('blocks','[]'::jsonb,'exercises',
        (SELECT jsonb_agg(to_jsonb(e) || jsonb_build_object('exercise',to_jsonb(x),'block',NULL,
          'measure_type','SECONDS','target_value',120,'target_value_min',NULL,'target_value_max',NULL,
          'reps_or_duration','120 s','timed_config','{"version":1,"unit":"SECONDS","segments":[{"action":"Run","seconds":20,"unit":"SECONDS"}]}'::jsonb))
        FROM training_exercises e JOIN exercises x ON x.id=e.exercise_id WHERE e.training_id=t.id))
      FROM trainings t WHERE t.id=$3`,
      [f.client, date, f.training],
    );
    await pool.query(
      `INSERT INTO rir_day_targets(client_id,date,training_exercise_id,training_id,target_rir)
      VALUES ($1,$2,$3,$4,1)`,
      [f.client, date, f.occurrence, f.training],
    );
    await cut(f);
    const result = await service.publish(f.client, date, f);
    expect(result).toMatchObject({
      status: 'stored',
      prescription: {
        training: {
          units: [
            {
              effective_content: {
                basis: 'known',
                training: {
                  exercises: [
                    {
                      target_value: 120,
                      target_rir: 1,
                      timed_config: {
                        segments: [{ action: 'Run', seconds: 20 }],
                      },
                    },
                  ],
                },
              },
              catalog_projection: {
                authoritative: false,
                exercises: [{ target_value: null, target_rir: 3 }],
              },
            },
          ],
        },
      },
    });
    expect(await service.publish(f.client, date, f)).toEqual(result);
  });
  it('real activation commit proof refuses preactivation days and real future cut stays UNKNOWN', async () => {
    const f = await fixture(true);
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      expect(
        (
          await c.query<{ value: unknown }>(
            'SELECT public.begin_adherence_history_cut($1,$2,128) value',
            [f.epochId, '2099-01-02T00:00:00.000000Z'],
          )
        ).rows[0].value,
      ).toBeNull();
      await c.query('ROLLBACK');
      await c.query('BEGIN');
      const barrier = (
        await c.query<{
          value: { barrier_boundary: string; full_xids: string[] };
        }>('SELECT public.begin_adherence_history_cut($1,$2,128) value', [
          f.epochId,
          cutoff,
        ])
      ).rows[0].value;
      expect(barrier.full_xids).toHaveLength(1);
      const xid = barrier.full_xids[0];
      const content = (
        await c.query<{ value: { content_digest: string } }>(
          'SELECT public.adherence_commit_payload($1,$2) value',
          [f.epochId, xid],
        )
      ).rows[0].value;
      const stamp = (
        await c.query<{ timestamp: string; micros: string }>(
          `SELECT to_char(pg_xact_commit_timestamp($1::xid) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') timestamp,
        (extract(epoch FROM pg_xact_commit_timestamp($1::xid))*1000000)::numeric(30,0)::text micros`,
          [xid],
        )
      ).rows[0];
      await c.query(
        'SELECT public.issue_adherence_commit_evidence($1,$2,$3,$4,$5,$6)',
        [
          f.epochId,
          f.origin,
          xid,
          stamp.timestamp,
          stamp.micros,
          content.content_digest,
        ],
      );
      await expect(
        c.query('SELECT public.issue_adherence_history_cut($1,$2,$3,$4)', [
          f.epochId,
          f.origin,
          cutoff,
          barrier.barrier_boundary,
        ]),
      ).rejects.toMatchObject({ code: '22000' });
      await c.query('ROLLBACK');
      expect(await service.publish(f.client, date, f)).toEqual({
        status: 'unknown',
        reason: 'unproven_original_cut',
      });
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });
  it('new overlay barrier drains an actual in-flight writer and remains held through COMMIT', async () => {
    const f = await fixture(true);
    const writer = await pool.connect();
    const barrier = await pool.connect();
    const future = await pool.connect();
    try {
      const pidW = (
        await writer.query<{ pid: number }>('SELECT pg_backend_pid() pid')
      ).rows[0].pid;
      const pidB = (
        await barrier.query<{ pid: number }>('SELECT pg_backend_pid() pid')
      ).rows[0].pid;
      const pidF = (
        await future.query<{ pid: number }>('SELECT pg_backend_pid() pid')
      ).rows[0].pid;
      await writer.query('BEGIN');
      const xid = (
        await writer.query<{ xid: string }>(
          'SELECT pg_current_xact_id()::text xid',
        )
      ).rows[0].xid;
      await writer.query(
        `INSERT INTO rir_day_targets(client_id,date,training_exercise_id,training_id,target_rir) VALUES ($1,$2,$3,$4,1)`,
        [f.client, date, f.occurrence, f.training],
      );
      await barrier.query('BEGIN');
      const pending = barrier.query<{ value: { full_xids: string[] } }>(
        'SELECT public.begin_adherence_history_cut($1,$2,128) value',
        [f.epochId, cutoff],
      );
      await blocked(pidB, pidW);
      await writer.query('COMMIT');
      const result = await pending;
      expect(result.rows[0].value.full_xids).toContain(xid);
      const later = future.query(
        `INSERT INTO rir_day_targets(client_id,date,training_exercise_id,training_id,target_rir) VALUES ($1,$2,$3,$4,2)`,
        [f.client, date, f.occurrence + '-later', f.training],
      );
      await blocked(pidF, pidB);
      await barrier.query('COMMIT');
      await later;
    } finally {
      await writer.query('ROLLBACK');
      await barrier.query('ROLLBACK');
      writer.release();
      barrier.release();
      future.release();
    }
  });
  it('restricted nonowner writes capture atomically without journal/allocator/function grants, including rollback and owner cascade', async () => {
    const f = await fixture(true);
    const runtime = 'effective_writer_' + randomUUID().replaceAll('-', '');
    await pool.query(`CREATE ROLE ${runtime}; GRANT USAGE ON SCHEMA public TO ${runtime};
      GRANT SELECT ON public.users,public.day_progress,public.rir_protected_days,public.rir_day_targets TO ${runtime};
      GRANT INSERT ON public.diet_day_snapshots,public.training_day_snapshots,public.rir_day_targets TO ${runtime};
      GRANT UPDATE ON public.rir_day_targets TO ${runtime}`);
    const c = await pool.connect();
    try {
      await c.query(`SET ROLE ${runtime}`);
      for (const statement of [
        'SELECT * FROM adherence_catalog_journal',
        "SELECT nextval(pg_get_serial_sequence('public.adherence_assignment_journal','event_sequence'))",
        'SELECT public.capture_adherence_effective_event()',
        `INSERT INTO adherence_catalog_journal(source_table,operation,new_row) VALUES ('rir_day_targets','INSERT','{}')`,
      ])
        await expect(c.query(statement)).rejects.toMatchObject({
          code: '42501',
        });
      await c.query('BEGIN');
      const rollbackXid = (
        await c.query<{ xid: string }>('SELECT pg_current_xact_id()::text xid')
      ).rows[0].xid;
      await c.query(
        `INSERT INTO rir_day_targets(client_id,date,training_exercise_id,training_id,target_rir) VALUES ($1,$2,$3,$4,1)`,
        [f.client, date, f.occurrence, f.training],
      );
      await c.query('ROLLBACK');
      expect(
        (
          await pool.query(
            'SELECT * FROM adherence_catalog_journal WHERE transaction_id=$1',
            [rollbackXid],
          )
        ).rows,
      ).toEqual([]);
      await c.query('BEGIN');
      const xid = (
        await c.query<{ xid: string }>('SELECT pg_current_xact_id()::text xid')
      ).rows[0].xid;
      await c.query(
        `INSERT INTO diet_day_snapshots(client_id,date,diet_id,provenance,diet) VALUES ($1,$2,'runtime','legacy_available','{}')`,
        [f.client, date],
      );
      await c.query(
        `INSERT INTO training_day_snapshots(client_id,date,training_id,payload) VALUES ($1,$2,$3,'{}')`,
        [f.client, date, f.training],
      );
      await c.query(
        `INSERT INTO rir_day_targets(client_id,date,training_exercise_id,training_id,target_rir)
        VALUES ($1,$2,$3,$4,1),($1,$2,$5,$4,2)`,
        [f.client, date, f.occurrence, f.training, f.occurrence + '-bulk'],
      );
      await c.query('COMMIT');
      const events = await pool.query<{
        operation: string;
        old_row: unknown;
        new_row: Record<string, unknown>;
      }>(
        'SELECT operation,old_row,new_row FROM adherence_catalog_journal WHERE transaction_id=$1',
        [xid],
      );
      expect(events.rows).toHaveLength(4);
      expect(
        events.rows.every(
          (e) =>
            e.operation === 'INSERT' &&
            e.old_row === null &&
            e.new_row.client_id === f.client,
        ),
      ).toBe(true);
      const complete = await pool.query(
        `SELECT to_jsonb(s) image FROM diet_day_snapshots s WHERE client_id=$1
        UNION ALL SELECT to_jsonb(s) FROM training_day_snapshots s WHERE client_id=$1
        UNION ALL SELECT to_jsonb(s) FROM rir_day_targets s WHERE client_id=$1`,
        [f.client],
      );
      expect(events.rows.map((e) => e.new_row)).toEqual(
        expect.arrayContaining(
          complete.rows.map((r: { image: unknown }) => r.image),
        ),
      );
      // Legal future target UPDATE: capture exact full OLD/NEW, not a projected
      // subset. Protected key moves remain rejected by existing source policy.
      await c.query(
        `INSERT INTO rir_day_targets(client_id,date,training_exercise_id,training_id,target_rir)
        VALUES ($1,'2099-01-01',$2,$3,1)`,
        [f.client, f.occurrence, f.training],
      );
      const old = (
        await pool.query<{ image: unknown }>(
          "SELECT to_jsonb(s) image FROM rir_day_targets s WHERE client_id=$1 AND date='2099-01-01'",
          [f.client],
        )
      ).rows[0].image;
      await c.query('BEGIN');
      const updateXid = (
        await c.query<{ xid: string }>('SELECT pg_current_xact_id()::text xid')
      ).rows[0].xid;
      await c.query(
        `UPDATE rir_day_targets SET target_rir=2 WHERE client_id=$1 AND date='2099-01-01'`,
        [f.client],
      );
      await c.query('COMMIT');
      const next = (
        await pool.query<{ image: unknown }>(
          "SELECT to_jsonb(s) image FROM rir_day_targets s WHERE client_id=$1 AND date='2099-01-01'",
          [f.client],
        )
      ).rows[0].image;
      expect(
        (
          await pool.query(
            'SELECT old_row,new_row FROM adherence_catalog_journal WHERE transaction_id=$1',
            [updateXid],
          )
        ).rows,
      ).toEqual([{ old_row: old, new_row: next }]);
      await c.query('RESET ROLE');
      // Existing immutable source policy forbids snapshot/key rewrites; no
      // disabling old triggers to invent a runtime path. Owner cascade is legal.
      await expect(
        pool.query(
          'UPDATE rir_day_targets SET training_exercise_id=$1 WHERE client_id=$2',
          [f.occurrence + '-move', f.client],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await pool.query('DELETE FROM users WHERE id=$1', [f.client]);
      const deleted = await pool.query<{ n: number }>(
        `SELECT count(*)::int n FROM adherence_catalog_journal WHERE operation='DELETE'
        AND source_table IN ('diet_day_snapshots','training_day_snapshots','rir_day_targets') AND old_row->>'client_id'=$1`,
        [f.client],
      );
      expect(deleted.rows[0].n).toBe(5);
      const deletedImages = await pool.query(
        "SELECT old_row FROM adherence_catalog_journal WHERE operation='DELETE' AND old_row->>'client_id'=$1 AND source_table IN ('diet_day_snapshots','training_day_snapshots','rir_day_targets')",
        [f.client],
      );
      expect(
        deletedImages.rows.map((r: { old_row: unknown }) => r.old_row),
      ).toEqual(
        expect.arrayContaining(
          complete.rows.map((r: { image: unknown }) => r.image),
        ),
      );
      expect(
        deletedImages.rows.map((r: { old_row: unknown }) => r.old_row),
      ).toContainEqual(next);
    } finally {
      await c.query('ROLLBACK');
      await c.query('RESET ROLE');
      c.release();
    }
  });
  it('owner publisher exists after actual88 upgrade', async () => {
    expect(
      (
        await pool.query(
          `SELECT public.adherence_prescription_source('absent','absent',$1) value`,
          [cutoff],
        )
      ).rows,
    ).toEqual([{ value: { state: 'unknown' } }]);
    const functions = await pool.query<{
      name: string;
      definer: boolean;
      config: string[];
      public_execute: boolean;
    }>(
      `SELECT p.proname name,p.prosecdef definer,p.proconfig config,
        EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') public_execute
       FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname IN ('assert_adherence_prescription_owner','adherence_prescription_source','publish_adherence_prescription') ORDER BY p.proname`,
    );
    expect(functions.rows).toHaveLength(3);
    for (const fn of functions.rows) {
      expect(fn.definer).toBe(false);
      expect(fn.config).toContain('search_path=pg_catalog');
      expect(fn.public_execute).toBe(false);
    }
  });
  it('publishes complete untimed/timed catalog projections, known ordered membership and sanitized basis', async () => {
    const f = await fixture();
    const second = f.training + '-second';
    const block = f.training + '-block';
    await pool.query(`BEGIN;
      INSERT INTO trainings(id,name,type,tags,updated_at) VALUES ('${second}','Second','TIMED','{}',now());
      INSERT INTO training_blocks(id,training_id,"order",type,rounds,rest_between_rounds_seconds,updated_at) VALUES ('${block}','${second}',0,'CIRCUIT',4,45,now());
      INSERT INTO training_exercises(id,training_id,exercise_id,block_id,"order",position_in_block,sets,reps_or_duration,measure_type,target_value,timed_config)
        VALUES ('${f.occurrence}-timed','${second}','${f.exercise}','${block}',0,0,2,'60 s','SECONDS',60,'{"version":1,"unit":"SECONDS","segments":[{"action":"Run","seconds":20,"unit":"SECONDS"}]}');
      INSERT INTO plan_assignment_trainings(id,assignment_id,training_id,position) VALUES ('${f.link}-second','${f.assignment}','${second}',1);
      COMMIT;`);
    await cut(f);
    const result = await published(f);
    const units = result.prescription.training.units;
    expect(units.map((u) => [u.id, u.position])).toEqual([
      [f.link, 0],
      [f.link + '-second', 1],
    ]);
    expect(units[0].catalog_projection.exercises[0]).toMatchObject({
      id: f.occurrence,
      exercise_id: f.exercise,
      name: 'Squat',
      sets: 3,
      reps_or_duration: '8-12',
      target_value_min: 8,
      target_value_max: 12,
      target_rir: 3,
      rir_override: { mode: 'FIXED', value: 2 },
      request_set_tracking: true,
      rest_seconds: 60,
    });
    expect(units[1].catalog_projection.blocks[0]).toMatchObject({
      id: block,
      rounds: 4,
      rest_between_rounds_seconds: 45,
    });
    expect(
      units[1].catalog_projection.exercises[0].timed_config?.segments,
    ).toEqual([{ action: 'Run', seconds: 20, unit: 'SECONDS' }]);
    expect(JSON.stringify(result)).not.toMatch(
      /signed|video_url|created_by|notes|firebase|Profile/,
    );
    expect(result.prescription.nutrition).toEqual({
      basis: 'known',
      reason: null,
      diet_id: null,
      groups: [],
    });
    const mislabeled = {
      ...result.prescription,
      training: {
        ...result.prescription.training,
        units: units.map((unit) => ({
          ...unit,
          effective_content: { ...unit.effective_content, basis: 'known' },
        })),
      },
    };
    await expect(
      pool.query(
        'SELECT public.publish_adherence_prescription($1,$2,$3,$4,$5,$6::jsonb,$7)',
        [
          f.client,
          date,
          f.epochId,
          f.origin,
          cutoff,
          JSON.stringify(mislabeled),
          result.manifest_digest,
        ],
      ),
    ).rejects.toMatchObject({ code: '22000' });
    expect(await service.read(f.client, date)).toEqual(result);
  });
  it('actual OLD-key move and source cascades leave no ghost', async () => {
    const f = await fixture();
    await pool.query('UPDATE plan_assignment_trainings SET id=$1 WHERE id=$2', [
      f.link + '-moved',
      f.link,
    ]);
    const block = f.training + '-cascade';
    await pool.query(
      'INSERT INTO training_blocks(id,training_id,"order",updated_at) VALUES ($1,$2,0,now())',
      [block, f.training],
    );
    await pool.query('UPDATE training_exercises SET block_id=$1 WHERE id=$2', [
      block,
      f.occurrence,
    ]);
    await pool.query('DELETE FROM training_blocks WHERE id=$1', [block]);
    await cut(f);
    const result = await published(f);
    expect(result.prescription.training.units.map((u) => u.id)).toEqual([
      f.link + '-moved',
    ]);
    expect(
      result.prescription.training.units[0].catalog_projection.exercises,
    ).toEqual([]);
  });
  it('later ordinary catalog, assignment, key and cascade changes cannot alter stored or rebuilt basis', async () => {
    const f = await fixture();
    await cut(f);
    const original = await published(f);
    await pool.query('UPDATE trainings SET name=$1 WHERE id=$2', [
      'Later catalog',
      f.training,
    ]);
    await pool.query(
      'UPDATE plan_assignments SET is_rest_day=true, training_id=null WHERE id=$1',
      [f.assignment],
    );
    await pool.query('DELETE FROM plan_assignment_trainings WHERE id=$1', [
      f.link,
    ]);
    await pool.query('DELETE FROM trainings WHERE id=$1', [f.training]);
    expect(await service.read(f.client, date)).toEqual(original);
    expect(await service.publish(f.client, date, f)).toEqual(original);
    expect(
      (
        await pool.query<{ n: number }>(
          'SELECT count(*)::int n FROM adherence_historical_prescriptions WHERE client_id=$1 AND date=$2',
          [f.client, date],
        )
      ).rows[0].n,
    ).toBe(1);
  });
  it('uses commit evidence to exclude cross-cut OLD/NEW events, not observations or event sequence', async () => {
    const f = await fixture();
    const connection = await pool.connect();
    let xid: string;
    try {
      await connection.query('BEGIN');
      xid = (
        await connection.query<{ xid: string }>(
          'SELECT pg_current_xact_id()::text xid',
        )
      ).rows[0].xid;
      await connection.query('UPDATE trainings SET name=$1 WHERE id=$2', [
        'After cutoff',
        f.training,
      ]);
      await connection.query('COMMIT');
    } finally {
      connection.release();
    }
    await cut(f, [xid]);
    expect(
      (await published(f)).prescription.training.units[0].catalog_projection
        .name,
    ).toBe('Original');
  });
  it('unbound observed snapshot never becomes known catalog/Profile nutrition', async () => {
    const f = await fixture();
    const diet = f.client + '-diet';
    await pool.query(
      `INSERT INTO diets(id,name,total_calories,total_protein_g,updated_at) VALUES ($1,'V2',2200,120,now())`,
      [diet],
    );
    await pool.query(
      `INSERT INTO diet_day_snapshots(client_id,date,diet_id,version,provenance,diet) VALUES ($1,$2,$3,1,'legacy_available','{"name":"V1","total_calories":1800,"total_protein_g":90}')`,
      [f.client, date, diet],
    );
    await pool.query('UPDATE plan_assignments SET diet_id=$1 WHERE id=$2', [
      diet,
      f.assignment,
    ]);
    await cut(f);
    expect(
      (
        await pool.query<{ name: string }>(
          "SELECT diet->>'name' name FROM diet_day_snapshots WHERE client_id=$1 AND date=$2 AND diet_id=$3",
          [f.client, date, diet],
        )
      ).rows[0].name,
    ).toBe('V1');
    const h1 = await published(f);
    expect(await published(f)).toEqual(h1);
    expect(h1.prescription.nutrition).toEqual({
      basis: 'unknown',
      reason: 'unproven_original_diet_snapshot_precedence',
      diet_id: diet,
      groups: [],
    });
    expect(JSON.stringify(h1)).not.toMatch(
      /2200|1800|total_protein_g|total_calories/,
    );
  });
  it('proves rest/no assignment separately and rejects legacy missing-cut and future-day publication', async () => {
    const f = await fixture();
    await pool.query(
      'DELETE FROM plan_assignment_trainings WHERE assignment_id=$1',
      [f.assignment],
    );
    await pool.query(
      'UPDATE plan_assignments SET training_id=null,is_rest_day=true WHERE id=$1',
      [f.assignment],
    );
    await cut(f);
    expect((await published(f)).prescription.training).toEqual({
      membership_basis: 'known',
      rest: true,
      units: [],
    });
    const absent = await service.publish('unassigned-' + randomUUID(), date, f);
    expect(absent).toMatchObject({
      status: 'stored',
      prescription: {
        assignment_id: null,
        training: { rest: false, units: [] },
        nutrition: { basis: 'known', groups: [] },
      },
    });
    expect(
      await service.publish(f.client, date, { ...f, epochId: 'missing' }),
    ).toEqual({ status: 'unknown', reason: 'unproven_original_cut' });
    // A deliberately owner-issued future FIXTURE manifest tests the consumer's
    // closure guard even when original digests and commit bindings validate.
    await cut({ ...f, cutoffUtc: '2099-01-02T00:00:00.000000Z' }, [], true);
    expect(
      (
        await service.publish(f.client, '2099-01-01', {
          ...f,
          cutoffUtc: '2099-01-02T00:00:00.000000Z',
        })
      ).status,
    ).toBe('unknown');
    expect(
      (
        await pool.query<{ n: number }>(
          `SELECT count(*)::int n FROM adherence_historical_prescriptions WHERE date='2099-01-01'`,
        )
      ).rows[0].n,
    ).toBe(0);
  });
  it('canonical reader works without private grants; cannot publish, mutate or leak another client through service', async () => {
    const f = await fixture();
    await cut(f);
    const expected = await published(f);
    await pool.query(
      `CREATE ROLE ${role}; GRANT SELECT ON public.adherence_historical_prescriptions TO ${role}`,
    );
    const connection = await pool.connect();
    try {
      await connection.query(`SET ROLE ${role}`);
      const reader = new AdherencePrescriptionService(
        sql(connection),
        publisher(pool),
      );
      expect(await reader.read(f.client, date)).toEqual(expected);
      expect(await reader.read('another-client', date)).toEqual({
        status: 'unknown',
        reason: 'missing_stored_basis',
      });
      for (const query of [
        'SELECT * FROM adherence_history_baselines',
        'SELECT * FROM adherence_catalog_journal',
        'SELECT * FROM adherence_assignment_journal',
        `SELECT public.adherence_prescription_source('x','x','${cutoff}')`,
        `SELECT public.publish_adherence_prescription('x','2020-01-01','x','x','${cutoff}','{}'::jsonb,'x')`,
        `DELETE FROM adherence_historical_prescriptions WHERE client_id='${f.client}'`,
      ])
        await expect(connection.query(query)).rejects.toMatchObject({
          code: '42501',
        });
    } finally {
      await connection.query('RESET ROLE');
      connection.release();
    }
    for (const statement of [
      'UPDATE adherence_historical_prescriptions SET payload=payload',
      'DELETE FROM adherence_historical_prescriptions',
      'TRUNCATE adherence_historical_prescriptions',
    ])
      await expect(pool.query(statement)).rejects.toMatchObject({
        code: '55000',
      });
  });
  it('exact and discordant concurrent writes serialize at a forced real barrier without overwrite', async () => {
    const f = await fixture();
    await cut(f);
    const expected = await published(f);
    // Use another client with identical proven unassigned basis for first INSERT.
    const client = 'race-' + randomUUID();
    const canonical = {
      ...expected.prescription,
      client_id: client,
      assignment_id: null,
      training: { membership_basis: 'known', rest: false, units: [] },
    };
    const a = await pool.connect();
    const b = await pool.connect();
    const call =
      'SELECT public.publish_adherence_prescription($1,$2,$3,$4,$5,$6::jsonb,$7) value';
    const values = [
      client,
      date,
      f.epochId,
      f.origin,
      cutoff,
      JSON.stringify(canonical),
      expected.manifest_digest,
    ];
    try {
      const pidA = (
        await a.query<{ pid: number }>('SELECT pg_backend_pid() pid')
      ).rows[0].pid;
      const pidB = (
        await b.query<{ pid: number }>('SELECT pg_backend_pid() pid')
      ).rows[0].pid;
      await a.query('BEGIN');
      await a.query(call, values);
      const pending = b.query<{ value: { prescription: unknown } }>(
        call,
        values,
      );
      await blocked(pidB, pidA);
      await a.query('COMMIT');
      const exact = await pending;
      expect(exact.rows[0].value.prescription).toEqual(canonical);
      await a.query('BEGIN');
      await a.query(
        'SELECT payload FROM adherence_historical_prescriptions WHERE client_id=$1 FOR UPDATE',
        [client],
      );
      // ON CONFLICT DO NOTHING takes a key-share check; force INSERT conflict via
      // a second fresh client instead of relying on an existing-row UPDATE lock.
      await a.query('ROLLBACK');
      const secondClient = 'conflict-' + randomUUID();
      const second = { ...canonical, client_id: secondClient };
      const good = [...values];
      good[0] = secondClient;
      good[5] = JSON.stringify(second);
      const bad = [...good];
      bad[5] = JSON.stringify({ ...second, assignment_id: 'discordant' });
      await a.query('BEGIN');
      await a.query(call, good);
      const rejected = b.query(call, bad).then(
        () => null,
        (error: unknown) => error,
      );
      await blocked(pidB, pidA);
      await a.query('COMMIT');
      expect(await rejected).toMatchObject({ code: '22000' });
      expect(
        (
          await pool.query<{ payload: { prescription: unknown } }>(
            'SELECT payload FROM adherence_historical_prescriptions WHERE client_id=$1',
            [secondClient],
          )
        ).rows[0].payload.prescription,
      ).toEqual(second);
    } finally {
      await a.query('ROLLBACK');
      a.release();
      b.release();
    }
  });
});
