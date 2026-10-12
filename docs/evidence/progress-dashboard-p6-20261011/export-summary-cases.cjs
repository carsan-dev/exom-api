const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { Pool } = require('pg');
const ROOT = path.resolve(__dirname, '../../..');
const { assertOwned, environment } = require(path.join(ROOT, 'scripts/run-recap-review-persistence.cjs'));
const { assertTestDatabase } = require(path.join(ROOT, 'scripts/test-database.cjs'));
const sourcePaths = ['src/modules/client-followup-tasks/client-followup-tasks.service.ts', 'src/modules/client-followup-tasks/client-followup-tasks.queries.ts', 'src/common/date-only.ts'];
const hash = (value) => createHash('sha256').update(value).digest('hex');
const taskId = '55555555-5555-4555-8555-555555555555';
const reviewId = '66666666-6666-4666-8666-666666666666';
const row = (overrides = {}) => ({ id: taskId, client_id: 'client-1', title: 'Próxima tarea canónica', type: 'CALL', due_date: '2026-10-10', priority: 'HIGH', status: 'PENDING', created_at: '2026-10-01T00:00:00Z', version: 1, ...overrides });
const scenarios = [
  { name: 'overdue', rows: [row(), row({ id: reviewId, type: 'REVIEW', title: 'Revisión canónica', due_date: '2026-10-11' })] },
  { name: 'empty', rows: [] },
  { name: 'today', rows: [row({ title: 'Tarea de hoy canónica', due_date: '2026-10-11' })] },
  { name: 'future', rows: [row({ title: 'Tarea futura canónica', due_date: '2026-10-12' })] },
  { name: 'changed', rows: [row({ title: 'Cambio canónico', version: 2 })] },
  { name: 'ties', rows: [
    row({ id: '77777777-7777-4777-8777-777777777777' }), row(),
    row({ id: reviewId, type: 'REVIEW', title: 'Revisión canónica' }),
    row({ id: '88888888-8888-4888-8888-888888888888', created_at: '2026-10-02T00:00:00Z' }),
    row({ id: '99999999-9999-4999-8999-999999999999', priority: 'LOW' }),
    row({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', due_date: '2026-10-12' }),
  ] },
  { name: 'closed-status', rows: [row({ status: 'COMPLETED' }), row({ id: reviewId, type: 'REVIEW', status: 'CANCELLED' })] },
  { name: 'client-isolation', rows: [row({ client_id: 'client-2' }), row({ id: reviewId, client_id: 'client-2', type: 'REVIEW' })] },
];
function docker(args, env) {
  const result = spawnSync('docker', args, { env, encoding: 'utf8', shell: false });
  if (result.status !== 0) throw Error('Local Docker operation failed; no fallback');
  return result.stdout.trim();
}
async function main() {
  const directory = path.join(__dirname, 'canonical-' + randomUUID());
  fs.mkdirSync(directory);
  const env = environment(directory);
  assert.match(docker(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], env), /^npipe:/);
  const imageId = docker(['image', 'inspect', 'postgres:17-bookworm', '--format', '{{.Id}}'], env);
  assert.equal(imageId, 'sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0');
  const name = 'exom-p6-summary-' + randomUUID();
  const password = randomUUID();
  const id = docker(['run', '--pull=never', '--detach', '--name', name, '--label', 'exom.scope=' + name, '--publish', '127.0.0.1::5432', '--tmpfs', '/var/lib/postgresql/exom-ci-data:rw', '--tmpfs', '/var/lib/postgresql/data:rw', '--env', 'POSTGRES_USER=exom_ci', '--env', 'POSTGRES_PASSWORD=' + password, '--env', 'POSTGRES_DB=exom_ci', '--env', 'PGDATA=/var/lib/postgresql/exom-ci-data', imageId], env);
  const owned = { id, name, imageId };
  const inspect = () => assertOwned(JSON.parse(docker(['inspect', id], env))[0], owned);
  inspect();
  fs.writeFileSync(path.join(directory, 'resource.json'), JSON.stringify({ ...owned, retention: 'Retained own tmpfs resource; no cleanup performed' }, null, 2));
  for (let attempt = 0; attempt < 60; attempt++) {
    inspect();
    if (spawnSync('docker', ['exec', id, 'pg_isready', '-h', '127.0.0.1', '-U', 'exom_ci', '-d', 'exom_ci'], { env, stdio: 'ignore' }).status === 0) break;
    if (attempt === 59) throw Error('Owned PostgreSQL readiness failed');
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const url = `postgresql://exom_ci:${password}@127.0.0.1:${owned.port}/exom_ci`;
  const pool = new Pool({ connectionString: url, ssl: false });
  let prisma;
  const RealDate = Date;
  try {
    await assertTestDatabase(pool, url);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema='public'")).rows[0].count, 0);
    inspect();
    await pool.query(`CREATE TYPE "Role" AS ENUM ('CLIENT','ADMIN','SUPER_ADMIN');
      CREATE TABLE users (id text PRIMARY KEY, role "Role", is_active boolean, is_locked boolean, is_archived boolean, identity_pending boolean);
      CREATE TABLE client_followup_tasks (id uuid PRIMARY KEY, client_id text, title text, type text, due_date date, priority text, status text, created_at timestamptz, assigned_to_id text, version integer);
      INSERT INTO users VALUES ('staff-1','SUPER_ADMIN',true,false,false,false), ('client-1','CLIENT',true,false,false,false), ('client-2','CLIENT',true,false,false,false);`);
    // Fence .env reads and external connections before loading current production code.
    require(path.join(directory, 'privacy.cjs'));
    process.env.DATABASE_URL = url;
    process.env.TEST_DATABASE_URL = url;
    process.env.DATABASE_SSL_MODE = 'disable';
    process.env.NODE_ENV = 'test';
    require('ts-node').register({ transpileOnly: true, project: path.join(ROOT, 'tsconfig.json') });
    const { PrismaService } = require(path.join(ROOT, 'src/prisma/prisma.service.ts'));
    const { ClientFollowUpTasksService } = require(path.join(ROOT, sourcePaths[0]));
    prisma = new PrismaService();
    await prisma.$connect();
    const service = new ClientFollowUpTasksService(prisma);
    const frozen = RealDate.parse('2026-10-11T12:00:00Z');
    global.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : [frozen])); }
      static now() { return frozen; }
    };
    const cases = [];
    for (const scenario of scenarios) {
      inspect();
      await assertTestDatabase(pool, url);
      await pool.query('DELETE FROM client_followup_tasks');
      for (const task of scenario.rows) {
        await pool.query('INSERT INTO client_followup_tasks (id,client_id,title,type,due_date,priority,status,created_at,assigned_to_id,version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,$9)', [task.id, task.client_id, task.title, task.type, task.due_date, task.priority, task.status, task.created_at, task.version]);
      }
      cases.push({ name: scenario.name, summary: await service.summary('client-1', { id: 'staff-1', role: 'SUPER_ADMIN' }) });
    }
    assert.equal(cases[0].summary.next_task.overdue, true);
    assert.equal(cases[0].summary.next_review.overdue, false);
    assert.equal(cases[2].summary.next_task.overdue, false);
    assert.equal(cases[3].summary.next_task.overdue, false);
    assert.equal(cases[4].summary.next_task.version, 2);
    assert.equal(cases[5].summary.next_task.id, taskId);
    assert.equal(cases[5].summary.next_review.id, reviewId);
    for (const index of [1, 6, 7]) assert.deepEqual(cases[index].summary, { as_of_date: '2026-10-11', next_task: null, next_review: null });
    const sources = Object.fromEntries(sourcePaths.map((file) => [file, hash(fs.readFileSync(path.join(ROOT, file)))]));
    const provenance = { generator: 'REAL_CURRENT_SERVICE_POSTGRESQL', frozen_utc: '2026-10-11T12:00:00Z', service: sourcePaths[0], query: sourcePaths[1], source_sha256: sources, inputs_sha256: hash(JSON.stringify(scenarios)), schema: 'minimal synthetic projection tables; not migration acceptance', actor: 'synthetic SUPER_ADMIN; full HTTP authorization proved separately' };
    const output = JSON.stringify({ provenance, cases }, null, 2) + '\n';
    fs.writeFileSync(path.join(directory, 'inputs.json'), JSON.stringify(scenarios, null, 2));
    fs.writeFileSync(path.join(directory, 'summary-cases.json'), output);
    fs.writeFileSync(path.join(ROOT, '../exom-admin/docs/evidence/progress-dashboard-p6-20261011/browser/summary-cases.json'), output);
    fs.writeFileSync(path.join(directory, 'receipt.json'), JSON.stringify({ result: 'PASS', cases: cases.length, output_sha256: hash(output), sources, resource: owned }, null, 2));
    console.log(JSON.stringify({ result: 'PASS', cases: cases.length, output_sha256: hash(output), evidence: path.relative(ROOT, directory), resource: owned }));
  } finally {
    global.Date = RealDate;
    await prisma?.$disconnect();
    if (prisma && !prisma.postgresqlPool.ended) await prisma.postgresqlPool.end();
    await pool.end();
  }
}
main().catch(() => { console.error('Canonical exporter failed; retained own resource, no fallback or secret diagnostics'); process.exitCode = 1; });
