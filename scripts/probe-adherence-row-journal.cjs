// Synthetic row-image replay diagnostic only: no production history or commit-cutoff proof.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');
const { assertTestDatabase } = require('./test-database.cjs');
const NAME = 'exom-p4-t1-ci-20260928';
function gate() {
  for (const key of ['TEST_DATABASE_URL', 'DATABASE_URL', 'PRISMA_DATABASE_URL', 'DIRECT_URL']) {
    assert.ok(process.env[key]);
    const url = new URL(process.env[key]);
    assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
    assert.equal(url.hostname, '127.0.0.1');
    assert.equal(url.port, '55493');
    assert.equal(url.pathname, '/exom_ci');
    assert.equal(url.username, 'exom_ci');
    assert.equal(url.search, '');
    assert.equal(url.hash, '');
    assert.equal(process.env[key], process.env.TEST_DATABASE_URL);
  }
  assert.equal(process.env.DATABASE_SSL_MODE, 'disable');
  // Inspect stays in memory; never print environment, credentials, or raw Docker output.
  const container = JSON.parse(execFileSync('docker', ['inspect', NAME], {
    encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  }))[0];
  assert.equal(container.Name, `/${NAME}`);
  assert.equal(container.Config?.Image, 'postgres:17');
  assert.equal(container.Config?.Labels?.['exom.scope'], 'p4-t1-20260928');
  assert.equal(container.State?.Running, true);
  assert.deepEqual(container.NetworkSettings?.Ports?.['5432/tcp'],
    [{ HostIp: '127.0.0.1', HostPort: '55493' }]);
  assert.equal(container.Mounts?.length, 2);
  assert.ok(container.Mounts.every((mount) => mount.Type === 'volume'));
  assert.ok(container.Mounts.some((mount) => mount.Name === `${NAME}-data` &&
    mount.Destination === '/var/lib/postgresql/exom-ci-data'));
  for (const setting of ['POSTGRES_DB=exom_ci', 'POSTGRES_USER=exom_ci',
    'PGDATA=/var/lib/postgresql/exom-ci-data']) assert.ok(container.Config?.Env?.includes(setting));
}
function replay(rows) {
  const state = { parent: new Map(), link: new Map() };
  for (const row of rows) {
    const [table, op] = row.op.split(':');
    assert.ok(Object.hasOwn(state, table));
    if (row.old_row) assert.deepEqual(state[table].get(row.old_row.id), row.old_row);
    if (op === 'DELETE') state[table].delete(row.old_row.id);
    else {
      assert.ok(op === 'INSERT' || op === 'UPDATE');
      // UPDATE may change identity: remove OLD before installing NEW.
      if (op === 'UPDATE') state[table].delete(row.old_row.id);
      state[table].set(row.new_row.id, row.new_row);
    }
  }
  return state;
}
const membership = (state, parent) => [...state.link.values()]
  .filter((row) => row.parent_id === parent).map((row) => row.id).sort();
async function main() {
  gate();
  const schema = `p4_row_journal_${randomUUID().replaceAll('-', '')}`;
  const marker = `synthetic-row-journal:${schema}`;
  const client = new Client({ connectionString: process.env.TEST_DATABASE_URL, ssl: false,
    connectionTimeoutMillis: 3000, query_timeout: 5000, statement_timeout: 4000 });
  let created = false;
  await client.connect();
  const write = async (sql, params = []) => {
    gate();
    await assertTestDatabase(client);
    return client.query(sql, params);
  };
  try {
    await assertTestDatabase(client);
    await write(`CREATE SCHEMA "${schema}"`);
    created = true;
    await write(`COMMENT ON SCHEMA "${schema}" IS '${marker}'`);
    await write(`CREATE TABLE "${schema}".parent(id text PRIMARY KEY);
      CREATE TABLE "${schema}".link(id text PRIMARY KEY,
        parent_id text NOT NULL REFERENCES "${schema}".parent(id) ON DELETE CASCADE);
      CREATE TABLE "${schema}".journal(seq bigserial PRIMARY KEY, op text NOT NULL,
        old_row jsonb, new_row jsonb);
      CREATE FUNCTION "${schema}".capture() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO "${schema}".journal(op,old_row,new_row)
        VALUES(TG_TABLE_NAME || ':' || TG_OP,
          CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END,
          CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END);
        RETURN NULL;
      END $$;
      CREATE TRIGGER capture AFTER INSERT OR UPDATE OR DELETE ON "${schema}".parent
        FOR EACH ROW EXECUTE FUNCTION "${schema}".capture();
      CREATE TRIGGER capture AFTER INSERT OR UPDATE OR DELETE ON "${schema}".link
        FOR EACH ROW EXECUTE FUNCTION "${schema}".capture();`);
    const journal = async () => (await client.query(`SELECT * FROM "${schema}".journal ORDER BY seq`)).rows;
    await write(`INSERT INTO "${schema}".parent VALUES ('P'),('Q');
      INSERT INTO "${schema}".link VALUES ('A','P'),('B','P'),('C','P')`);
    const seed = await journal();
    const baseline = seed.length;
    const seedSequence = seed.at(-1).seq;
    assert.equal(baseline, 5);
    await write('BEGIN');
    await write(`DELETE FROM "${schema}".link WHERE id IN ('A','B')`);
    assert.equal((await journal()).length, baseline + 2);
    await write('ROLLBACK');
    assert.deepEqual(await journal(), seed);
    await write(`DELETE FROM "${schema}".link WHERE id IN ('A','B')`);
    assert.equal((await journal()).length, baseline + 2);
    await write(`UPDATE "${schema}".link SET parent_id='Q' WHERE id='C'`);
    const current = (await client.query(`SELECT * FROM "${schema}".link WHERE parent_id='P'`)).rows;
    assert.equal(current.length, 0); // Current membership has lost all three OLD P links.
    await write(`UPDATE "${schema}".link SET id='D' WHERE id='C'`);
    await write(`DELETE FROM "${schema}".parent WHERE id='Q'`);
    const rows = await journal();
    assert.equal(rows.length, baseline + 6);
    assert.deepEqual(membership(replay(rows.filter((row) => BigInt(row.seq) <= BigInt(seedSequence))), 'P'), ['A', 'B', 'C']);
    const expected = replay(seed);
    for (let i = baseline; i < rows.length; i++) {
      const row = rows[i];
      const [table, op] = row.op.split(':');
      if (op === 'DELETE') {
        if (i < baseline + 2) {
          assert.equal(table, 'link');
          assert.ok(['A', 'B'].includes(row.old_row.id));
          assert.equal(row.old_row.parent_id, 'P');
        } else assert.ok((table === 'parent' && row.old_row.id === 'Q') ||
          (table === 'link' && row.old_row.id === 'D' && row.old_row.parent_id === 'Q'));
        expected[table].delete(row.old_row.id);
      }
      else {
        assert.equal(op, 'UPDATE');
        assert.equal(table, 'link');
        if (i === baseline + 2) {
          assert.deepEqual(row.old_row, { id: 'C', parent_id: 'P' });
          assert.deepEqual(row.new_row, { id: 'C', parent_id: 'Q' });
          expected.link.set('C', { id: 'C', parent_id: 'Q' });
        } else {
          assert.equal(i, baseline + 3);
          assert.deepEqual(row.old_row, { id: 'C', parent_id: 'Q' });
          assert.deepEqual(row.new_row, { id: 'D', parent_id: 'Q' });
          expected.link.delete('C');
          expected.link.set('D', { id: 'D', parent_id: 'Q' });
        }
      }
      assert.deepEqual(replay(rows.slice(0, i + 1)), expected);
      if (i === baseline + 1) assert.deepEqual(membership(expected, 'P'), ['C']);
      if (i === baseline + 2) assert.deepEqual(membership(expected, 'Q'), ['C']);
      if (i === baseline + 3) assert.deepEqual(membership(expected, 'Q'), ['D']);
    }
    assert.deepEqual([...expected.parent.keys()], ['P']);
    assert.equal(expected.link.size, 0);
    console.log(`seed_rows=${baseline} committed_rows=${rows.length} suffixes=6 historical_P_links=3 current_P_links=${current.length} rollback_committed_rows=0`);
  } finally {
    try {
      if (created) {
        await client.query('ROLLBACK');
        assert.match(schema, /^p4_row_journal_[a-f0-9]{32}$/);
        const owned = await client.query(`SELECT pg_get_userbyid(nspowner) AS owner,
          obj_description(oid,'pg_namespace') AS marker FROM pg_namespace WHERE nspname=$1`, [schema]);
        assert.equal(owned.rows.length, 1);
        assert.equal(owned.rows[0].owner, 'exom_ci');
        assert.equal(owned.rows[0].marker, marker);
        await write(`DROP SCHEMA "${schema}" CASCADE`);
        assert.equal((await client.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema])).rowCount, 0);
        console.log('cleanup_remaining_schemas=0');
      }
    } finally { await client.end(); }
  }
}
main().catch((error) => {
  console.error(error instanceof assert.AssertionError
    ? 'Synthetic diagnostic assertion failed; no sensitive details emitted'
    : 'Synthetic diagnostic failed; no sensitive details emitted');
  process.exitCode = 1;
});
