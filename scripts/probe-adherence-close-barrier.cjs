// Synthetic visibility diagnostic: no production writer coverage or UTC cutoff proof.
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
  // Inspect stays in memory; never print credentials or raw Docker output.
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
async function main() {
  gate();
  const schema = `p4_close_barrier_${randomUUID().replaceAll('-', '')}`;
  const marker = `synthetic-close-barrier:${schema}`;
  const key = BigInt.asIntN(64, BigInt(`0x${randomUUID().replaceAll('-', '').slice(0, 16)}`)).toString();
  const clients = Array.from({ length: 4 }, () => new Client({
    connectionString: process.env.TEST_DATABASE_URL, ssl: false,
    connectionTimeoutMillis: 3000, query_timeout: 5000, statement_timeout: 4000,
    idle_in_transaction_session_timeout: 15000,
  }));
  const [control, writer, stale, closure] = clients;
  let created = false;
  let pendingLock;
  const write = async (client, sql, params = []) => {
    gate();
    await assertTestDatabase(client);
    return client.query(sql, params);
  };
  const rows = async (client) => (await client.query(
    `SELECT seq, xid, content FROM "${schema}".events ORDER BY seq`)).rows;
  const insert = async (label) => {
    await write(writer, 'BEGIN');
    // The statement trigger takes the shared transaction barrier before any row write.
    await write(writer, `INSERT INTO "${schema}".events(content) VALUES ($1),($2)`,
      [`${label}1`, `${label}2`]);
  };
  const lock = () => closure.query('SELECT pg_advisory_xact_lock($1::bigint)', [key]);
  try {
    for (const client of clients) {
      await client.connect();
      await assertTestDatabase(client);
      assert.equal((await client.query('SHOW statement_timeout')).rows[0].statement_timeout, '4s');
      assert.equal((await client.query('SHOW idle_in_transaction_session_timeout'))
        .rows[0].idle_in_transaction_session_timeout, '15s');
    }
    await write(control, `CREATE SCHEMA "${schema}"`);
    created = true;
    await write(control, `COMMENT ON SCHEMA "${schema}" IS '${marker}'`);
    await write(control, `CREATE TABLE "${schema}".events(
      seq bigserial PRIMARY KEY, xid bigint NOT NULL DEFAULT txid_current(), content text NOT NULL);
      CREATE FUNCTION "${schema}".barrier() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock_shared(${key}::bigint);
        RETURN NULL;
      END $$;
      CREATE TRIGGER barrier BEFORE INSERT ON "${schema}".events
        FOR EACH STATEMENT EXECUTE FUNCTION "${schema}".barrier();`);
    await insert('A');
    assert.equal((await rows(writer)).length, 2);
    await stale.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    assert.equal((await rows(stale)).length, 0);
    await write(writer, 'COMMIT');
    assert.equal((await rows(control)).length, 2);
    assert.equal((await rows(stale)).length, 0);
    await stale.query('ROLLBACK');
    console.log('stale_before_commit=0 stale_after_commit=0 fresh_after_A=2 counterexample=observed');

    await insert('B');
    const writerPid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const closurePid = (await closure.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await closure.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    // Handle rejection immediately, even if polling fails before awaiting the lock.
    pendingLock = lock().then(() => ({ ok: true }), () => ({ ok: false }));
    const started = Date.now();
    let waiting = false;
    while (Date.now() - started < 2000) {
      const activity = await control.query(`SELECT state, wait_event_type, wait_event,
        $2::int = ANY(pg_blocking_pids(pid)) AS blocked_by_writer
        FROM pg_stat_activity WHERE pid=$1`, [closurePid, writerPid]);
      const state = activity.rows[0];
      if (state?.state === 'active' && state.wait_event_type === 'Lock' &&
          state.wait_event === 'advisory' && state.blocked_by_writer) {
        waiting = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(waiting, 'Closure must observably wait for the open shared writer');
    assert.equal((await rows(control)).length, 2);
    console.log(`closure_wait_observed=true wait_event=advisory blocked_by_writer=true poll_ms=${Date.now() - started}`);
    await write(writer, 'COMMIT');
    assert.equal((await pendingLock).ok, true);
    // A separate READ COMMITTED statement takes a fresh snapshot after the barrier.
    // No domain row locks are acquired while holding the exclusive barrier.
    const committed = await rows(closure);
    assert.deepEqual(committed.map((row) => row.content), ['A1', 'A2', 'B1', 'B2']);
    assert.equal(committed[0].xid, committed[1].xid);
    assert.equal(committed[2].xid, committed[3].xid);
    assert.notEqual(committed[0].xid, committed[2].xid);
    await closure.query('COMMIT');

    await insert('C');
    assert.equal((await rows(writer)).length, 6);
    await write(writer, 'ROLLBACK');
    await closure.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await lock();
    assert.deepEqual(await rows(closure), committed);
    await closure.query('COMMIT');
    console.log('closure_after_B=4 complete_transactions=2 rollback_C_added_rows=0 closure_after_C=4');
    console.log('statement_timeout_ms=4000 idle_transaction_timeout_ms=15000 query_timeout_ms=5000 poll_bound_ms=2000');
  } finally {
    // Release writer first, so any pending exclusive lock can finish before cleanup.
    try {
      for (const client of [writer, stale, closure]) {
        await client.query('ROLLBACK').catch(() => {});
      }
      if (pendingLock) await pendingLock;
      if (created) {
        assert.match(schema, /^p4_close_barrier_[a-f0-9]{32}$/);
        const owned = await control.query(`SELECT pg_get_userbyid(nspowner) AS owner,
          obj_description(oid,'pg_namespace') AS marker FROM pg_namespace WHERE nspname=$1`, [schema]);
        assert.equal(owned.rows.length, 1);
        assert.equal(owned.rows[0].owner, 'exom_ci');
        assert.equal(owned.rows[0].marker, marker);
        await write(control, `DROP SCHEMA "${schema}" CASCADE`);
        assert.equal((await control.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema])).rowCount, 0);
        console.log('cleanup_remaining_schemas=0');
      }
    } finally {
      const ended = await Promise.allSettled(clients.map((client) => client.end()));
      assert.ok(ended.every((result) => result.status === 'fulfilled'));
    }
  }
}
main().catch((error) => {
  console.error(error instanceof assert.AssertionError
    ? 'Synthetic diagnostic assertion failed; no sensitive details emitted'
    : 'Synthetic diagnostic failed; no sensitive details emitted');
  process.exitCode = 1;
});
