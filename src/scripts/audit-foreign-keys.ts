import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { databasePoolConfig } from '../prisma/pool-config';

type ForeignKey = {
  name: string;
  table_schema: string;
  table_name: string;
  target_schema: string;
  target_table: string;
  columns: string[];
  target_columns: string[];
  validated: boolean;
  match_type: string;
};
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const required = [
  'plan_assignments_client_id_fkey',
  'plan_assignments_admin_id_fkey',
  'auto_assignment_rules_client_id_fkey',
  'auto_assignment_rules_admin_id_fkey',
];

export async function auditForeignKeys(pool: Pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout = '120s'");
    const keys = await client.query<ForeignKey>(`
      SELECT c.conname name, ns.nspname table_schema, t.relname table_name,
        rns.nspname target_schema, rt.relname target_table, c.convalidated validated, c.confmatchtype match_type,
        ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num,ord)
          JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.num ORDER BY k.ord) columns,
        ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(num,ord)
          JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.num ORDER BY k.ord) target_columns
      FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace ns ON ns.oid=t.relnamespace
      JOIN pg_class rt ON rt.oid=c.confrelid JOIN pg_namespace rns ON rns.oid=rt.relnamespace
      WHERE c.contype='f' AND ns.nspname='public' ORDER BY t.relname,c.conname`);
    const results: Array<ForeignKey & { orphan_count: number }> = [];
    for (const key of keys.rows) {
      const populated = key.columns
        .map((col) => `s.${quote(col)} IS NOT NULL`)
        .join(' AND ');
      const joined = key.columns
        .map((col, i) => `s.${quote(col)} = r.${quote(key.target_columns[i])}`)
        .join(' AND ');
      const partialNull =
        key.match_type === 'f'
          ? ` OR ((${key.columns.map((col) => `s.${quote(col)} IS NULL`).join(' OR ')}) AND (${key.columns.map((col) => `s.${quote(col)} IS NOT NULL`).join(' OR ')}))`
          : '';
      const result = await client.query<{
        count: string;
      }>(`SELECT count(*) FROM ${quote(key.table_schema)}.${quote(key.table_name)} s
        WHERE (${populated} AND NOT EXISTS (SELECT 1 FROM ${quote(key.target_schema)}.${quote(key.target_table)} r WHERE ${joined}))${partialNull}`);
      results.push({ ...key, orphan_count: Number(result.rows[0].count) });
    }
    await client.query('COMMIT');
    return {
      constraints: results,
      missingRequired: required.filter(
        (name) => !results.some((row) => row.name === name),
      ),
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  if (process.argv.slice(2).some((arg) => arg !== '--read-only'))
    throw new Error(
      'This command is read-only; validation uses the reviewed migration',
    );
  const config = databasePoolConfig();
  const url = new URL(config.connectionString!);
  const target = createHash('sha256')
    .update(`${url.hostname}:${url.port || '5432'}${url.pathname}`)
    .digest('hex');
  const pool = new Pool(config);
  try {
    const result = await auditForeignKeys(pool);
    console.log(
      JSON.stringify(
        { date: new Date().toISOString(), target, readOnly: true, ...result },
        null,
        2,
      ),
    );
    if (
      result.missingRequired.length ||
      result.constraints.some((row) => row.orphan_count)
    )
      process.exitCode = 2;
  } finally {
    await pool.end();
  }
}
if (require.main === module)
  void main().catch(() => {
    // pg errors can contain values and connection details: never echo them.
    console.error(
      'Foreign-key audit failed; check database access and TLS configuration',
    );
    process.exitCode = 1;
  });
