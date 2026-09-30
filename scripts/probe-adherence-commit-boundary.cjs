// Disposable P4 diagnostic only: no production journal or adherence implementation.
// SIGKILL, host/process crashes, or Docker outages can prevent finally compensation.
// A failed compensation requires operator inspection of the reported unique schema
// and this exact container; never rerun with a changed baseline or clean globally.
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
const { assertTestDatabase } = require('./test-database.cjs');

const NAME = 'exom-p4-t1-ci-20260928';
const DATA = '/var/lib/postgresql/exom-ci-data';
const token = randomUUID();
const schema = `p4_commit_${token.replaceAll('-', '')}`;
const marker = `commit-boundary:${token}`;
let containerId;
let stage = 'preflight';
let interrupted = false;
const clients = new Set();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function check(condition, message) { if (!condition) throw new Error(message); }
function report(label, value) { console.log(`${label}: ${JSON.stringify(value)}`); }
function docker(args) {
  // Capture stderr: neither Docker nor driver errors are safe to print verbatim.
  return execFileSync('docker', args, {
    encoding: 'utf8', timeout: 60000, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
function gateContainer() {
  // Inspect ONLY nonsecret metadata, including only the PGDATA environment entry.
  const format = '{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Config.Image}},"scope":{{json (index .Config.Labels "exom.scope")}},"running":{{json .State.Running}},"ports":{{json .NetworkSettings.Ports}},"mounts":{{json .Mounts}},"pgdata":{{range .Config.Env}}{{if eq . "PGDATA=/var/lib/postgresql/exom-ci-data"}}{{json .}}{{end}}{{end}}}';
  const info = JSON.parse(docker(['inspect', '--format', format, NAME]));
  check(info.name === `/${NAME}` && info.image === 'postgres:17' &&
    info.scope === 'p4-t1-20260928' && info.running === true,
  'Container identity mismatch');
  check(JSON.stringify(info.ports) === JSON.stringify({
    '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '55493' }],
  }), 'Unexpected port bindings');
  check(info.pgdata === `PGDATA=${DATA}`, 'PGDATA mismatch');
  check(info.mounts.length === 2 && info.mounts.every((m) => m.Type === 'volume') &&
    info.mounts.filter((m) => m.Name === `${NAME}-data` && m.Destination === DATA && m.RW).length === 1,
  'Named volume mismatch');
  if (containerId) check(info.id === containerId, 'Container replaced; stop');
  else containerId = info.id;
}
function gateAliases() {
  const value = process.env.TEST_DATABASE_URL;
  check(!!value, 'Missing test URL');
  check(['DATABASE_URL', 'PRISMA_DATABASE_URL', 'DIRECT_URL'].every((n) =>
    process.env[n] === value), 'Database aliases differ');
  const url = new URL(value);
  check(url.protocol === 'postgresql:' && url.hostname === '127.0.0.1' &&
    url.port === '55493' && url.pathname === '/exom_ci' &&
    url.username === 'exom_ci' && !url.search && !url.hash &&
    process.env.DATABASE_SSL_MODE === 'disable', 'URL metadata or SSL mismatch');
}
async function connect() {
  const client = new Client({ connectionString: process.env.TEST_DATABASE_URL,
    ssl: false, connectionTimeoutMillis: 3000, statement_timeout: 5000,
    query_timeout: 6000, idle_in_transaction_session_timeout: 15000 });
  // Idle socket errors must not escape to stderr with driver details.
  client.on('error', () => {});
  clients.add(client);
  await client.connect();
  await assertTestDatabase(client);
  const { rows: [identity] } = await client.query(`SELECT
    current_setting('server_version_num')::integer / 10000 AS major,
    inet_server_port() AS port, (SELECT ssl FROM pg_stat_ssl
      WHERE pid=pg_backend_pid()) AS ssl`);
  check(identity.major === 17 && identity.port === 5432 && identity.ssl === false,
    'Database version/transport mismatch');
  return client;
}
async function close(client) {
  try { await client.end(); } finally { clients.delete(client); }
}
async function settings(client) {
  const { rows: [setting] } = await client.query(`SELECT setting, source, sourcefile,
    pending_restart FROM pg_settings WHERE name='track_commit_timestamp'`);
  const { rows: [files] } = await client.query(`SELECT count(*)::integer AS auto_entries,
    count(*) FILTER (WHERE error IS NOT NULL)::integer AS errors,
    bool_and(setting='on') AS auto_on
    FROM pg_file_settings WHERE name='track_commit_timestamp'
      AND sourcefile=current_setting('data_directory') || '/postgresql.auto.conf'`);
  return { ...setting, ...files };
}
function baseline(state) {
  return state.setting === 'off' && state.source === 'default' &&
    state.sourcefile === null && !state.pending_restart &&
    state.auto_entries === 0 && state.errors === 0;
}
function databaseCheck() {
  execFileSync(process.execPath, ['scripts/test-database.cjs'], {
    cwd: require('node:path').resolve(__dirname, '..'), timeout: 15000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  report('node scripts/test-database.cjs', 'PASS');
}
async function restart() {
  gateContainer();
  docker(['restart', '--time', '10', NAME]);
  // Bounded readiness, 30 attempts; each connection itself has a 3s limit.
  for (let attempt = 0; attempt < 30; attempt++) {
    let client;
    try {
      gateContainer();
      client = await connect();
      return client;
    } catch {
      if (client) await close(client);
      for (const failed of [...clients]) await close(failed).catch(() => {});
      await delay(250);
    }
  }
  throw new Error('Readiness deadline exceeded');
}
async function ownedSchema(client) {
  check(/^p4_commit_[a-f0-9]{32}$/.test(schema), 'Unsafe schema identifier');
  const { rows } = await client.query(`SELECT n.nspowner=(SELECT oid FROM pg_roles
    WHERE rolname=current_user) AS owned, obj_description(n.oid, 'pg_namespace')=$2 AS marked
    FROM pg_namespace n WHERE n.nspname=$1`, [schema, marker]);
  if (!rows.length) return false;
  check(rows.length === 1 && rows[0].owned && rows[0].marked,
    'Schema ownership ambiguous; do not clean');
  return true;
}
async function transaction(client, label) {
  await client.query('BEGIN');
  // xid8 carries an epoch; pg_xact_commit_timestamp accepts only the low 32-bit xid.
  const { rows: [info] } = await client.query(`SELECT transaction_timestamp()::text AS began,
    mod(pg_current_xact_id()::text::numeric, 4294967296)::text AS xid`);
  await client.query(`INSERT INTO "${schema}".payload VALUES ($1)`, [label]);
  await client.query(`INSERT INTO "${schema}".journal VALUES ($1, $2::xid)`, [label, info.xid]);
  return info;
}
async function experiment(observer) {
  check(!await ownedSchema(observer), 'Schema collision');
  // Atomic creation + invocation marker permits safe cleanup even after lost COMMIT response.
  await observer.query('BEGIN');
  await observer.query(`CREATE SCHEMA "${schema}"`);
  await observer.query(`COMMENT ON SCHEMA "${schema}" IS '${marker}'`);
  await observer.query(`CREATE TABLE "${schema}".payload(label text PRIMARY KEY)`);
  await observer.query(`CREATE TABLE "${schema}".journal(label text PRIMARY KEY, xid xid NOT NULL)`);
  await observer.query('COMMIT');
  check(await ownedSchema(observer), 'Missing owned schema');
  const a = await connect();
  const b = await connect();
  const infoA = await transaction(a, 'A');
  await a.query('COMMIT');
  const infoB = await transaction(b, 'B');
  const { rows: [stampA] } = await observer.query(
    'SELECT pg_xact_commit_timestamp($1::xid)::text AS committed', [infoA.xid]);
  check(stampA.committed !== null, 'A commit timestamp unavailable');
  // B remains uncommitted on its connection while observer establishes the cutoff.
  // Small 10ms DB sleeps avoid timestamp equality, not JS-clock ordering claims.
  let cutoff;
  for (let attempt = 0; attempt < 20; attempt++) {
    const { rows: [clock] } = await observer.query(`SELECT clock_timestamp()::text AS cutoff,
      clock_timestamp()>greatest($1::timestamptz,$2::timestamptz) AS ready`,
    [stampA.committed, infoB.began]);
    if (clock.ready) { cutoff = clock.cutoff; break; }
    await observer.query('SELECT pg_sleep(0.01)');
  }
  check(!!cutoff, 'No strictly later cutoff');
  const { rows: [before] } = await observer.query(`SELECT
    (SELECT count(*)::integer FROM "${schema}".journal) AS visible,
    pg_xact_commit_timestamp($1::xid) IS NULL AS b_uncommitted`, [infoB.xid]);
  check(before.visible === 1 && before.b_uncommitted, 'B crossed barrier prematurely');
  await b.query('COMMIT');
  const { rows: [boundary] } = await observer.query(`SELECT
    pg_xact_commit_timestamp($1::xid)::text AS commit_a,
    pg_xact_commit_timestamp($2::xid)::text AS commit_b,
    pg_xact_commit_timestamp($1::xid)<$3::timestamptz AS a_before,
    $4::timestamptz<$3::timestamptz AS b_began_before,
    pg_xact_commit_timestamp($2::xid)>=$3::timestamptz AS b_committed_after`,
  [infoA.xid, infoB.xid, cutoff, infoB.began]);
  check(boundary.a_before && boundary.b_began_before && boundary.b_committed_after,
    'Database commit-boundary assertions failed');
  report('boundary', { ...boundary, cutoff, b_began: infoB.began, visible_before_b_commit: before.visible });
  const rollback = await transaction(a, 'ROLLBACK');
  await a.query('ROLLBACK');
  const { rows: [counts] } = await observer.query(`SELECT
    (SELECT count(*)::integer FROM "${schema}".payload) AS payload,
    (SELECT count(*)::integer FROM "${schema}".journal) AS journal,
    (SELECT count(*)::integer FROM "${schema}".payload WHERE label='ROLLBACK') AS rollback_payload,
    (SELECT count(*)::integer FROM "${schema}".journal WHERE label='ROLLBACK') AS rollback_journal,
    pg_xact_commit_timestamp($1::xid) IS NULL AS rollback_timestamp_absent`, [rollback.xid]);
  check(counts.payload === 2 && counts.journal === 2 && counts.rollback_payload === 0 &&
    counts.rollback_journal === 0 && counts.rollback_timestamp_absent, 'Rollback/count assertions failed');
  report('synthetic_counts', counts);
  await close(a);
  await close(b);
}
async function main() {
  let original;
  let configAttempted = false;
  let schemaAttempted = false;
  let failed = false;
  try {
    gateAliases();
    gateContainer();
    databaseCheck();
    const observer = await connect();
    original = await settings(observer);
    report('original_setting', original);
    check(baseline(original), 'Unexpected baseline; no configuration changes allowed');
    stage = 'enable';
    gateContainer();
    configAttempted = true; // Set before SQL: a lost response still requires compensation.
    await observer.query("ALTER SYSTEM SET track_commit_timestamp='on'");
    await close(observer);
    const enabled = await restart();
    const active = await settings(enabled);
    report('enabled_setting', active);
    check(active.setting === 'on' && active.auto_entries === 1 && active.errors === 0 &&
      !active.pending_restart && active.sourcefile === `${DATA}/postgresql.auto.conf`, 'Enable verification failed');
    check(!interrupted, 'Interrupted before experiment');
    stage = 'experiment';
    schemaAttempted = true;
    report('synthetic_schema', schema);
    await experiment(enabled);
  } catch {
    failed = true;
    report('failure', { stage, detail: 'Failed; raw error intentionally suppressed' });
  } finally {
    // Disconnect all transactions first, rolling back any open work.
    for (const client of [...clients]) await close(client).catch(() => {});
    if (schemaAttempted) {
      stage = 'schema_cleanup';
      let cleaner;
      try {
        gateAliases(); gateContainer();
        cleaner = await connect();
        if (await ownedSchema(cleaner)) {
          await cleaner.query(`DROP SCHEMA "${schema}" CASCADE`);
        }
        check(!await ownedSchema(cleaner), 'Schema remains');
        report('schema_cleanup', { schema, remaining: 0 });
      } catch {
        failed = true;
        report('compensation_failure', { stage, schema, detail: 'Inspect only this schema; no global cleanup' });
      } finally { if (cleaner) await close(cleaner).catch(() => {}); }
    }
    if (configAttempted && baseline(original)) {
      stage = 'configuration_restore';
      let restorer;
      try {
        gateAliases(); gateContainer();
        restorer = await connect();
        const current = await settings(restorer);
        report('pre_restore_setting', current);
        // Only compensate our expected override (or an unchanged baseline).
        // An unexpected override is not ours to replace.
        check(baseline(current) || (current.auto_entries === 1 &&
          current.errors === 0 && current.auto_on === true &&
          ['off', 'on'].includes(current.setting)), 'Ambiguous configuration; stop');
        await restorer.query('ALTER SYSTEM RESET track_commit_timestamp');
        await close(restorer); restorer = undefined;
        restorer = await restart();
        const restored = await settings(restorer);
        report('restored_setting', restored);
        check(baseline(restored), 'Restored baseline mismatch');
        databaseCheck();
      } catch {
        failed = true;
        report('compensation_failure', { stage, container: NAME, detail: 'Restoration unverified; stop and inspect' });
      } finally { if (restorer) await close(restorer).catch(() => {}); }
    }
    report('limitations', ['Synthetic manual payload/journal transactions only; no production writers, bulk or cascades tested',
      'Database clock observations do not establish NTP or monotonic wall-clock guarantees',
      'Commit timestamp retention and production/Supabase enablement remain unvalidated deployment gates',
      'Finally cannot compensate SIGKILL, process/host crash, or unreachable Docker/database']);
    check(!failed && !interrupted, 'Diagnostic not successful');
    report('result', 'PASS');
  }
}
// Graceful signals trigger bounded normal unwinding; no claim of crash safety.
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { interrupted = true; });
main().catch(() => { process.exitCode = 1; });
