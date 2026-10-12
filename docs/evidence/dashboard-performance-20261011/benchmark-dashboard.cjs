const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const { performance } = require('node:perf_hooks');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '../../..');
const TODAY = '2026-10-11';
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const civil = (offset) => new Date(Date.parse(TODAY) + offset * 86400000);
const uuid = (value) => { const hex = sha(value); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`; };
function payloadHash(value) {
  const ordered = (item) => Array.isArray(item) ? item.map(ordered) : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, ordered(item[key])])) : item;
  return sha(JSON.stringify(ordered(value)));
}
function instrumentQueries(Client, storage) {
  const original = Client.prototype.query;
  Client.prototype.query = function (...args) {
    const context = storage.getStore();
    if (!context) return original.apply(this, args);
    const started = performance.now();
    const sql = typeof args[0] === 'string' ? args[0] : args[0].text;
    const key = sha(sql);
    let recorded = false;
    const record = (result) => {
      if (recorded) return;
      recorded = true;
      const elapsed = performance.now() - started;
      context.queries++;
      context.db_ms += elapsed;
      context.rows += result?.rowCount ?? 0;
      const group = context.sql[key] ?? { count: 0, ms: 0 };
      group.count++; group.ms += elapsed; context.sql[key] = group;
    };
    const callback = args[args.length - 1];
    if (typeof callback === 'function') args[args.length - 1] = (error, result) => { record(result); callback(error, result); };
    try {
      const result = original.apply(this, args);
      return typeof callback === 'function' ? result : result.then((value) => { record(value); return value; }, (error) => { record(); throw error; });
    } catch (error) { record(); throw error; }
  };
  return () => { Client.prototype.query = original; };
}
function summarize(samples) {
  assert.ok(samples.length, 'No measurements');
  assert.equal(new Set(samples.map((sample) => sample.hash)).size, 1, 'Canonical response drift');
  const metrics = {};
  for (const key of ['wall_ms', 'db_ms', 'queries', 'rows', 'bytes']) {
    const values = samples.map((sample) => sample[key]).sort((a, b) => a - b);
    metrics[key] = { median: values[Math.floor(values.length / 2)], min: values[0], max: values[values.length - 1] };
  }
  return { ...metrics, hash: samples[0].hash };
}
function endpointMap(client, today) {
  const base = `/admin/clients/${client}`;
  return [
    ['selector', '/admin/clients?page=1&limit=200'], ['session', '/auth/me'],
    ['profile', base], ['month', `${base}/calendar/month?year=2026&month=10`],
    ['day', `${base}/progress?date=${today}`], ['week', `${base}/calendar/week-summary?week_start=2026-10-05`],
    ['metrics_history', `${base}/metrics/overview?to=${today}&page=1`],
    ['metrics_30d', `${base}/metrics/overview?from=2026-09-12&to=${today}&page=1`],
    ['adherence', `${base}/adherence?start=2026-09-12&end=${today}`],
    ['summary', `${base}/follow-up-tasks/summary`],
    ['recaps', `/recaps?client_id=${client}&status=SUBMITTED&page=1&limit=20`],
  ];
}
function sourceManifest() {
  const listed = spawnSync('git', ['ls-files', 'src', 'prisma', 'package.json', 'package-lock.json', 'scripts/run-recap-review-persistence.cjs'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(listed.status, 0);
  const files = [...listed.stdout.trim().split(/\r?\n/), path.relative(ROOT, __filename), path.relative(ROOT, path.join(__dirname, 'test.cjs'))].sort();
  return Object.fromEntries(files.map((file) => [file.replaceAll('\\', '/'), sha(fs.readFileSync(path.join(ROOT, file)))]));
}
async function seed(prisma, days) {
  const fixed = new Date(`${TODAY}T12:00:00Z`);
  await prisma.user.createMany({ data: [
    { id: 'perf-admin', firebase_uid: 'perf-admin', email: 'admin@example.test', role: 'ADMIN', created_at: fixed, updated_at: fixed },
    { id: 'perf-outsider', firebase_uid: 'perf-outsider', email: 'outsider@example.test', role: 'ADMIN', created_at: fixed, updated_at: fixed },
    ...Array.from({ length: 200 }, (_, i) => ({ id: uuid(`perf-client-${i}`), firebase_uid: `perf-client-${i}`, email: `client${i}@example.test`, role: 'CLIENT', created_at: fixed, updated_at: fixed })),
  ] });
  await prisma.profile.createMany({ data: Array.from({ length: 200 }, (_, i) => ({ user_id: uuid(`perf-client-${i}`), first_name: 'Synthetic', last_name: `Client ${i}`, created_at: fixed, updated_at: fixed })) });
  await prisma.adminClientAssignment.createMany({ data: Array.from({ length: 200 }, (_, i) => ({ id: uuid('coach' + i), admin_id: 'perf-admin', client_id: uuid(`perf-client-${i}`), created_at: fixed })) });
  await prisma.diet.create({ data: { id: 'perf-diet', name: 'Synthetic diet', created_at: fixed, updated_at: fixed } });
  await prisma.meal.create({ data: { id: 'perf-meal', diet_id: 'perf-diet', name: 'Synthetic meal', type: 'BREAKFAST', calories: 350, protein_g: 20, carbs_g: 40, fat_g: 10, nutritional_badges: [], created_at: fixed, updated_at: fixed } });
  await prisma.training.create({ data: { id: 'perf-training', name: 'Synthetic training', type: 'STRENGTH', created_at: fixed, updated_at: fixed } });
  const body = [], progress = [], assignments = [], recaps = [];
  for (let i = 0; i < days; i++) {
    const date = civil(-i);
    body.push({ id: uuid('body' + i), client_id: uuid('perf-client-0'), date, weight_kg: i === 17 ? null : 80 + i / 1000, waist_cm: 90, sleep_hours: i % 3 ? 7 : null, created_at: fixed });
    progress.push({ id: uuid('progress' + i), client_id: uuid('perf-client-0'), date, meals_completed: i % 3 ? ['perf-meal'] : [], training_completed: i % 2 === 0, trainings_completed: i % 2 === 0 ? ['perf-training'] : [], created_at: fixed, updated_at: fixed });
    if (i % 7 === 6) recaps.push({ id: uuid('recap' + i), client_id: uuid('perf-client-0'), week_start_date: date, week_end_date: civil(-i + 6), status: i % 4 ? 'SUBMITTED' : 'DRAFT', submitted_at: i % 4 ? fixed : null, average_daily_steps: 7000 + i, stress_enabled: true, stress_level: 2, energy_level: 3, created_at: fixed, updated_at: fixed });
  }
  for (let i = -6; i < days; i++) assignments.push({ id: uuid('assignment' + i), client_id: uuid('perf-client-0'), admin_id: 'perf-admin', date: civil(-i), diet_id: 'perf-diet', training_id: 'perf-training', created_at: fixed, updated_at: fixed });
  // Chunk only fixture insertion, never substitute the measured production reads.
  for (const [model, rows] of [['bodyMetric', body], ['planAssignment', assignments], ['dayProgress', progress], ['weeklyRecap', recaps]]) {
    for (let start = 0; start < rows.length; start += 100) await prisma[model].createMany({ data: rows.slice(start, start + 100) });
  }
  await prisma.clientFollowUpTask.createMany({ data: [
    { id: uuid('task'), client_id: uuid('perf-client-0'), created_by_id: 'perf-admin', type: 'CALL', title: 'Synthetic call', due_date: civil(-1), priority: 'HIGH', created_at: fixed, updated_at: fixed },
    { id: uuid('review'), client_id: uuid('perf-client-0'), created_by_id: 'perf-admin', type: 'REVIEW', title: 'Synthetic review', due_date: civil(0), created_at: fixed, updated_at: fixed },
    { id: uuid('other-task'), client_id: uuid('perf-client-1'), created_by_id: 'perf-admin', type: 'CALL', title: 'Other client task', due_date: civil(-10), created_at: fixed, updated_at: fixed },
  ] });
  return { days, users: 202, clients: 200, metrics: body.length, progress: progress.length, assignments: assignments.length, recaps: recaps.length, completeFields: 'all response fields retained; fixtures include null weight, sparse sleep, drafts, historical meals and opposite client task' };
}
async function measure(directory, days) {
  require(path.join(directory, 'privacy.cjs'));
  require('ts-node').register({ transpileOnly: true, project: path.join(ROOT, 'tsconfig.json') });
  const { Pool, Client } = require('pg');
  const { assertTestDatabase } = require(path.join(ROOT, 'scripts/test-database.cjs'));
  const probe = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  try { await assertTestDatabase(probe); } finally { await probe.end(); }
  const identity = require(path.join(ROOT, 'src/common/firebase/firebase-id-token.ts'));
  identity.verifyFirebaseIdTokenWithFallback = async ({ token }) => {
    if (!['perf-admin', 'perf-outsider'].includes(token)) throw new identity.FirebaseIdTokenRejectedError();
    return { uid: token };
  };
  const { Test } = require('@nestjs/testing');
  const { AppModule } = require(path.join(ROOT, 'src/app.module.ts'));
  const { configureApp } = require(path.join(ROOT, 'src/configure-app.ts'));
  const { PrismaService } = require(path.join(ROOT, 'src/prisma/prisma.service.ts'));
  const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = module.createNestApplication({ logger: false });
  const storage = new AsyncLocalStorage();
  const requests = new Map();
  const undo = instrumentQueries(Client, storage);
  app.use((req, _res, next) => storage.run(requests.get(req.headers['x-benchmark-id']), next));
  configureApp(app);
  await app.init();
  const prisma = app.get(PrismaService);
  const RealDate = Date;
  try {
    const fixture = await seed(prisma, days);
    fs.writeFileSync(path.join(directory, 'fixture.json'), JSON.stringify(fixture, null, 2));
    const frozen = RealDate.parse(`${TODAY}T12:00:00Z`);
    global.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [frozen])); } static now() { return frozen; } };
    await app.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${app.getHttpServer().address().port}/api/v1`;
    const endpoints = endpointMap(uuid('perf-client-0'), TODAY);
    const saved = {};
    let sequence = 0;
    async function request(label, route, actor = 'perf-admin', expected = 200) {
      const key = String(++sequence);
      const context = { queries: 0, db_ms: 0, rows: 0, sql: {} };
      requests.set(key, context);
      const start = performance.now();
      try {
        const response = await fetch(base + route, { headers: { Authorization: 'Bearer ' + actor, 'x-benchmark-id': key } });
        const raw = await response.text();
        assert.equal(response.status, expected, label + ' HTTP status: ' + raw);
        const body = JSON.parse(raw);
        saved[label] ??= body;
        return { label, wall_ms: performance.now() - start, ...context, bytes: Buffer.byteLength(raw), hash: payloadHash(body) };
      } finally { requests.delete(key); }
    }
    const samples = {};
    for (const [label, route] of endpoints) {
      const runs = [];
      for (let i = 0; i < 6; i++) runs.push(await request(label, route));
      samples[label] = { first_request: runs[0], warm: summarize(runs.slice(1)), samples: runs };
    }
    const burstStart = performance.now();
    const parallel = await Promise.all(endpoints.map(([label, route]) => request(label, route)));
    const burstMs = performance.now() - burstStart;
    for (const item of parallel) assert.equal(item.hash, samples[item.label].warm.hash, 'Parallel response drift: ' + item.label);
    await request('unauthorized_profile', '/admin/clients/' + uuid('perf-client-0'), 'perf-outsider', 403);
    const other = await request('other_summary', '/admin/clients/' + uuid('perf-client-1') + '/follow-up-tasks/summary');
    assert.notEqual(other.hash, samples.summary.warm.hash);
    assert.equal(saved.metrics_history.data.client_id, uuid('perf-client-0'));
    assert.equal(saved.metrics_history.data.series.find((series) => series.key === 'weight_kg').count, days - 1);
    const result = { fixture, fixture_hash: payloadHash(fixture), clock: TODAY, protocol: 'first per-endpoint request after fixture seeding in a fresh child process, not database-cache-cold; five warm repeats; one concurrent burst', auth: 'synthetic Firebase token verification seam; real auth/roles/database/client authorization guards', db_time: 'sum of actual pg Client.query completion wall times, includes round trips; overlapping queries are additive, not server-exclusive CPU', responses: saved, endpoints: samples, parallel: { wall_ms: burstMs, requests: parallel } };
    fs.writeFileSync(path.join(directory, 'measurement.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ days, burst_ms: burstMs, ranked: Object.entries(samples).map(([endpoint, item]) => ({ endpoint, wall_ms: item.warm.wall_ms.median, db_ms: item.warm.db_ms.median, queries: item.warm.queries.median, bytes: item.warm.bytes.median })).sort((a, b) => b.wall_ms - a.wall_ms) }));
  } finally { global.Date = RealDate; undo(); await app.close(); }
}
async function baseline() {
  const { database, environment } = require(path.join(ROOT, 'scripts/run-recap-review-persistence.cjs'));
  const before = sourceManifest();
  for (const days of [30, 1825]) {
    const directory = path.join(__dirname, 'run-' + days + '-' + crypto.randomUUID());
    fs.mkdirSync(directory);
    const env = environment(directory);
    const context = spawnSync('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], { env, encoding: 'utf8' });
    assert.equal(context.status, 0); assert.match(context.stdout, /^npipe:/);
    const inspectSafe = await database(env, directory, 'all');
    inspectSafe();
    const child = spawnSync(process.execPath, [__filename, '--measure', directory, String(days)], { cwd: ROOT, env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    fs.writeFileSync(path.join(directory, 'local.log'), (child.stdout ?? '') + (child.stderr ?? ''));
    inspectSafe();
    fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ before, after: sourceManifest(), command: 'node docs/evidence/dashboard-performance-20261011/benchmark-dashboard.cjs --baseline', exit: child.status }, null, 2));
    assert.deepEqual(sourceManifest(), before, 'Source changed during measurement');
    assert.equal(child.status, 0, 'Measurement failed; retained local evidence ' + path.relative(ROOT, directory));
    const report = JSON.parse(fs.readFileSync(path.join(directory, 'measurement.json')));
    console.log(JSON.stringify({ result: 'PASS', days, evidence: path.relative(ROOT, directory), parallel_ms: report.parallel.wall_ms, ranked: Object.entries(report.endpoints).map(([endpoint, item]) => ({ endpoint, wall_ms: item.warm.wall_ms.median, db_ms: item.warm.db_ms.median, queries: item.warm.queries.median, bytes: item.warm.bytes.median })).sort((a, b) => b.wall_ms - a.wall_ms) }));
  }
}
module.exports = { instrumentQueries, payloadHash, summarize, endpointMap };
if (require.main === module) {
  const work = process.argv[2] === '--baseline' ? baseline() : process.argv[2] === '--measure' ? measure(process.argv[3], Number(process.argv[4])) : Promise.reject(Error('Expected --baseline'));
  work.catch((error) => { console.error(error.message); process.exitCode = 1; });
}
