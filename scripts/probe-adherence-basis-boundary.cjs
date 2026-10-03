// Disposable PostgreSQL behavior probe; never connect through an application URL.
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { databaseUrl, verifyDatabase, assertTestDatabase } = require('./test-database.cjs');

const schema = `exom_p4_basis_probe_${randomUUID().replace(/-/g, '')}`;
const schemaPattern = /^exom_p4_basis_probe_[0-9a-f]{32}$/;
if (!schemaPattern.test(schema)) throw Error('Invalid generated schema identifier');

async function main() {
  // The guard runs before any write and checks the database, role, and PGDATA.
  await verifyDatabase();
  const pool = new Pool({ connectionString: databaseUrl(), max: 3, connectionTimeoutMillis: 3000 });
  let created = false;
  let cleanupConfirmed = false;
  try {
    await assertTestDatabase(pool);
    await pool.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    await pool.query(`CREATE TABLE "${schema}".assignment (id integer PRIMARY KEY)`);
    await pool.query(`CREATE TABLE "${schema}".link (
      id integer PRIMARY KEY, assignment_id integer NOT NULL
        REFERENCES "${schema}".assignment(id) ON DELETE CASCADE)`);
    await pool.query(`CREATE TABLE "${schema}".captured (
      link_id integer PRIMARY KEY, assignment_id integer NOT NULL)`);
    await pool.query(`CREATE TABLE "${schema}".observed (
      link_id integer PRIMARY KEY, visible_count integer NOT NULL, inserted_count integer NOT NULL)`);
    await pool.query(`CREATE FUNCTION "${schema}".capture_links() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE visible integer; inserted integer;
      BEGIN
        SELECT count(*) INTO visible FROM "${schema}".link WHERE assignment_id = OLD.assignment_id;
        INSERT INTO "${schema}".captured (link_id, assignment_id)
          SELECT id, assignment_id FROM "${schema}".link WHERE assignment_id = OLD.assignment_id
          ON CONFLICT (link_id) DO NOTHING;
        GET DIAGNOSTICS inserted = ROW_COUNT;
        INSERT INTO "${schema}".observed VALUES (OLD.id, visible, inserted);
        RETURN OLD;
      END $$`);
    await pool.query(`CREATE TRIGGER capture_before_delete BEFORE DELETE ON "${schema}".link
      FOR EACH ROW EXECUTE FUNCTION "${schema}".capture_links()`);
    await pool.query(`INSERT INTO "${schema}".assignment VALUES (1), (2), (3)`);
    await pool.query(`INSERT INTO "${schema}".link VALUES
      (11,1), (12,1), (13,1), (21,2), (22,2), (23,2)`);

    const bulk = await pool.query(`DELETE FROM "${schema}".link WHERE assignment_id = 1`);
    const cascade = await pool.query(`DELETE FROM "${schema}".assignment WHERE id = 2`);
    const { rows: membership } = await pool.query(`SELECT c.assignment_id,
      count(*)::integer AS calls, min(o.visible_count)::integer AS min_visible,
      max(o.visible_count)::integer AS max_visible,
      sum(o.inserted_count)::integer AS inserted,
      count(DISTINCT c.link_id)::integer AS captured
      FROM "${schema}".captured c JOIN "${schema}".observed o ON o.link_id = c.link_id
      GROUP BY c.assignment_id ORDER BY c.assignment_id`);
    const { rows: observations } = await pool.query(`SELECT l.assignment_id,
      array_agg(o.visible_count ORDER BY o.link_id) AS visible_per_call,
      array_agg(o.inserted_count ORDER BY o.link_id) AS inserted_per_call
      FROM "${schema}".observed o
      JOIN "${schema}".captured l ON l.link_id = o.link_id
      GROUP BY l.assignment_id ORDER BY l.assignment_id`);
    console.log('Observed synthetic deletes:', JSON.stringify({ bulkRows: bulk.rowCount,
      parentRows: cascade.rowCount, membership, observations }));
    console.log('Scope: observed in this synthetic run, not proven for application tables or every plan/interleaving.');

    const clock = await pool.connect();
    try {
      await clock.query('BEGIN');
      const { rows: [times] } = await clock.query(`WITH cutoff AS (
        SELECT CURRENT_TIMESTAMP + interval '60 milliseconds' AS boundary)
        SELECT CURRENT_TIMESTAMP < boundary AS tx_before,
          statement_timestamp() < boundary AS statement_before,
          clock_timestamp() < boundary AS clock_before FROM cutoff`);
      await clock.query('SELECT pg_sleep(0.15)');
      const { rows: [after] } = await clock.query(`WITH cutoff AS (
        SELECT CURRENT_TIMESTAMP + interval '60 milliseconds' AS boundary)
        SELECT CURRENT_TIMESTAMP < boundary AS tx_before,
          statement_timestamp() < boundary AS statement_before,
          clock_timestamp() < boundary AS clock_before FROM cutoff`);
      await clock.query('ROLLBACK');
      console.log('Observed synthetic cutoff before/after sleep:', JSON.stringify({ times, after }));
      console.log('This demonstrates timestamp semantics only; it does not establish atomic commit behavior.');
    } finally { clock.release(); }

    // A parent row FOR UPDATE conflicts with the FK key-share check on INSERT.
    const locker = await pool.connect();
    const inserter = await pool.connect();
    try {
      await locker.query('BEGIN');
      await locker.query(`SELECT id FROM "${schema}".assignment WHERE id = 3 FOR UPDATE`);
      await inserter.query("SET lock_timeout = '150ms'");
      let insertStatus = 'unexpected-success';
      try {
        await inserter.query(`INSERT INTO "${schema}".link VALUES (31,3)`);
      } catch (error) {
        insertStatus = error.code === '55P03' ? 'lock-timeout' : 'other-error';
        if (insertStatus === 'other-error') throw error;
      }
      await locker.query('ROLLBACK');
      const { rows: [row] } = await pool.query(`SELECT count(*)::integer AS links
        FROM "${schema}".link WHERE assignment_id = 3`);
      console.log('Observed parent-lock/FK insert:', JSON.stringify({ insertStatus, remainingLinks: row.links }));
    } finally {
      // A rollback is harmless if the explicit rollback already completed.
      try { await locker.query('ROLLBACK'); } finally { locker.release(); inserter.release(); }
    }
  } finally {
    try {
      if (created && schemaPattern.test(schema)) {
        // Do not drop a namespace that no longer belongs to this session's role.
        await assertTestDatabase(pool);
        const { rows: [namespace] } = await pool.query(`SELECT n.nspowner = current_user::regrole AS owned
          FROM pg_namespace n WHERE n.nspname = $1`, [schema]);
        if (!namespace || !namespace.owned) throw Error('Generated namespace absent or owner changed');
        await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
        const { rows: [remaining] } = await pool.query(`SELECT count(*)::integer AS count
          FROM pg_namespace WHERE nspname = $1`, [schema]);
        cleanupConfirmed = remaining.count === 0;
        if (!cleanupConfirmed) throw Error('Generated namespace still exists');
      } else {
        const { rows: [remaining] } = await pool.query(`SELECT count(*)::integer AS count
          FROM pg_namespace WHERE nspname = $1`, [schema]);
        cleanupConfirmed = remaining.count === 0;
        if (!cleanupConfirmed) throw Error('Unconfirmed schema creation');
      }
      console.log('Generated schema absent after cleanup:', cleanupConfirmed);
    } catch {
      console.error(`Cleanup uncertain; STOP. Inspect only generated schema ${schema} in isolated exom_ci.`);
      throw Error('Cleanup not verified');
    } finally { await pool.end(); }
  }
}

main().catch(() => { console.error('Synthetic probe failed; see bounded status above.'); process.exitCode = 1; });
