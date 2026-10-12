import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { assertTestDatabase } from '../scripts/test-database.cjs';

const migration =
  '20261005210000_add_weekly_recap_review_drafts_and_publication';
const textFields = [
  'draft_coach_summary',
  'draft_changes',
  'draft_next_week_goals',
  'published_coach_summary',
  'published_changes',
  'published_next_week_goals',
];
const reviewFields = [...textFields, 'review_version'];
interface Identity {
  database: string;
  role: string;
  directory: string;
}
interface Column {
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
}
interface Snapshot {
  table: string;
  rows: unknown[];
}
const tables = ['users', 'weekly_recaps', 'body_metrics', 'streaks'];
async function snapshot(pool: Pool): Promise<Snapshot[]> {
  const result: Snapshot[] = [];
  for (const table of tables) {
    const { rows } = await pool.query<{ row: unknown }>(
      `SELECT to_jsonb(t) - $1::text[] AS row FROM "${table}" t ORDER BY id`,
      [table === 'weekly_recaps' ? reviewFields : []],
    );
    result.push({ table, rows: rows.map((row) => row.row) });
  }
  return result;
}
async function columns(pool: Pool): Promise<Column[]> {
  const { rows } = await pool.query<Column>(
    `SELECT column_name,data_type,is_nullable,column_default
     FROM information_schema.columns WHERE table_schema='public'
     AND table_name='weekly_recaps' ORDER BY ordinal_position`,
  );
  return rows;
}

describe('REST-T3A isolated PostgreSQL additive review persistence', () => {
  let fresh: Pool;
  let upgrade: Pool;
  let before: Snapshot[];
  let oldColumns: Column[];
  beforeAll(async () => {
    if (
      !process.env.TEST_DATABASE_URL ||
      !process.env.RECAP_UPGRADE_DATABASE_URL
    )
      throw new Error(
        'Owned runner URLs required; no fallback or skipped tests',
      );
    fresh = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      ssl: false,
    });
    upgrade = new Pool({
      connectionString: process.env.RECAP_UPGRADE_DATABASE_URL,
      ssl: false,
    });
    await assertTestDatabase(fresh);
    const expected = new URL(process.env.TEST_DATABASE_URL);
    expected.pathname = '/exom_ci_recap_upgrade';
    if (process.env.RECAP_UPGRADE_DATABASE_URL !== expected.toString())
      throw new Error('Upgrade must belong to the same owned cluster');
    const {
      rows: [identity],
    } = await upgrade.query<Identity>(
      `SELECT current_database() AS database,current_user AS role,
       current_setting('data_directory') AS directory`,
    );
    expect(identity).toEqual({
      database: 'exom_ci_recap_upgrade',
      role: 'exom_ci',
      directory: '/var/lib/postgresql/exom-ci-data',
    });
    for (const pool of [fresh, upgrade]) {
      const { rows } = await pool.query(
        "SELECT tablename FROM pg_tables WHERE schemaname='public'",
      );
      expect(rows).toEqual([]);
    }
    const root = join(process.cwd(), 'prisma/migrations');
    const names = readdirSync(root)
      .filter((name) => /^\d/.test(name))
      .sort();
    expect(
      names
        .filter((name) => name.startsWith('20261005210000'))
        .every((name) => name === migration),
    ).toBe(true);
    for (const name of names) {
      const sql = readFileSync(join(root, name, 'migration.sql'), 'utf8');
      await fresh.query(sql);
      if (name !== migration) await upgrade.query(sql);
    }
    oldColumns = await columns(upgrade);
    await upgrade.query(`INSERT INTO users(id,email,firebase_uid,updated_at)
      VALUES ('legacy-client','legacy@example.test','synthetic-legacy','2026-01-01')`);
    for (const [index, status] of [
      'DRAFT',
      'SUBMITTED',
      'REVIEWED',
    ].entries()) {
      await upgrade.query(
        `INSERT INTO weekly_recaps
        (id,client_id,week_start_date,week_end_date,status,training_notes,
         admin_comments,client_feedback_text,client_feedback_sent_at,
         client_feedback_read_at,submitted_at,reviewed_at,archived_at,
         improvement_areas,created_at,updated_at)
        VALUES ($1,'legacy-client',$2::date,$2::date+6,$3::"RecapStatus",
         $4,$4,$4,'2026-01-01 01:02:03.456','2026-01-02 04:05:06.789',
         '2026-01-03','2026-01-04',$5,ARRAY['legacy'],
         '2026-01-01','2026-01-05')`,
        [
          `legacy-${index}`,
          `2026-01-${String(5 + index * 7).padStart(2, '0')}`,
          status,
          '  Legacy ñ\nunaltered\r\n  ',
          index === 2 ? '2026-01-06' : null,
        ],
      );
    }
    await upgrade.query(`INSERT INTO body_metrics(id,client_id,date,weight_kg)
      VALUES ('legacy-metric','legacy-client','2026-01-01',81.25)`);
    await upgrade.query(`INSERT INTO streaks(id,client_id,current_days,longest_days,updated_at)
      VALUES ('legacy-streak','legacy-client',4,19,'2026-01-01')`);
    before = await snapshot(upgrade);
    if (names.includes(migration))
      await upgrade.query(
        readFileSync(join(root, migration, 'migration.sql'), 'utf8'),
      );
  }, 120000);
  afterAll(async () => {
    await fresh?.end();
    await upgrade?.end(); // Connections only; resources/data retained.
  });

  it('creates exactly six nullable text fields and a required zero-default integer on fresh and upgraded schemas', async () => {
    for (const pool of [fresh, upgrade]) {
      const added = (await columns(pool)).filter((column) =>
        reviewFields.includes(column.column_name),
      );
      expect(added).toHaveLength(7);
      for (const field of textFields)
        expect(added.find((column) => column.column_name === field)).toEqual({
          column_name: field,
          data_type: 'text',
          is_nullable: 'YES',
          column_default: null,
        });
      expect(
        added.find((column) => column.column_name === 'review_version'),
      ).toEqual({
        column_name: 'review_version',
        data_type: 'integer',
        is_nullable: 'NO',
        column_default: '0',
      });
    }
    expect(await columns(fresh)).toEqual(await columns(upgrade));
  });

  it('preserves every prior recap column and populated legacy history byte values without backfill', async () => {
    expect(
      (await columns(upgrade)).filter(
        (column) => !reviewFields.includes(column.column_name),
      ),
    ).toEqual(oldColumns);
    expect(await snapshot(upgrade)).toEqual(before);
    const { rows } = await upgrade.query<Record<string, unknown>>(
      'SELECT * FROM weekly_recaps ORDER BY id',
    );
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      for (const field of textFields) expect(row[field]).toBeNull();
      expect(row.review_version).toBe(0);
    }
  });

  it('stores drafts independently from publication and retains legacy timestamps and feedback', async () => {
    const {
      rows: [previous],
    } = await upgrade.query<{ legacy: unknown }>(
      'SELECT to_jsonb(t) - $1::text[] AS legacy FROM weekly_recaps t WHERE id=$2',
      [reviewFields, 'legacy-2'],
    );
    await upgrade.query(
      `UPDATE weekly_recaps SET published_coach_summary=$1,
      published_changes=$1,published_next_week_goals=$1,
      draft_coach_summary=$2,draft_changes=$2,draft_next_week_goals=$2,
      review_version=1 WHERE id='legacy-2'`,
      ['published ñ\n', 'draft \r\n'],
    );
    await upgrade.query(
      "UPDATE weekly_recaps SET draft_coach_summary=NULL,draft_changes='edited',review_version=2 WHERE id='legacy-2'",
    );
    const {
      rows: [row],
    } = await upgrade.query<Record<string, unknown>>(
      'SELECT * FROM weekly_recaps WHERE id=$1',
      ['legacy-2'],
    );
    for (const field of textFields.filter((field) =>
      field.startsWith('published_'),
    ))
      expect(row[field]).toBe('published ñ\n');
    expect(row.draft_coach_summary).toBeNull();
    expect(row.draft_changes).toBe('edited');
    expect(row.review_version).toBe(2);
    const {
      rows: [current],
    } = await upgrade.query<{ legacy: unknown }>(
      'SELECT to_jsonb(t) - $1::text[] AS legacy FROM weekly_recaps t WHERE id=$2',
      [reviewFields, 'legacy-2'],
    );
    expect(current).toEqual(previous);
  });

  it('defaults new legacy-shaped inserts to unpublished and rejects a null review version', async () => {
    await fresh.query(`INSERT INTO users(id,email,firebase_uid,updated_at)
      VALUES ('fresh-client','fresh@example.test','synthetic-fresh','2026-01-01')`);
    const {
      rows: [row],
    } = await fresh.query<Record<string, unknown>>(`INSERT INTO weekly_recaps
      (id,client_id,week_start_date,week_end_date,updated_at)
      VALUES ('fresh-recap','fresh-client','2026-01-05','2026-01-11','2026-01-01')
      RETURNING *`);
    for (const field of textFields) expect(row[field]).toBeNull();
    expect(row.review_version).toBe(0);
    await expect(
      fresh.query(
        "UPDATE weekly_recaps SET review_version=NULL WHERE id='fresh-recap'",
      ),
    ).rejects.toMatchObject({ code: '23502' });
  });
});
