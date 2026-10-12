'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixturePlan, guardClocks, guardProject, provision, prismaAdapter, safeCode } = require('./provision-p4-smoke-fixtures.cjs');
const date = '2026-09-30';
const sample = () => ({ local: date, utc: date, offset: '+0000', zone: 'GMT' });
const clocks = () => ({ host: sample(), device: sample(), docker: sample(), database: sample() });
const canonical = {
  normalizeAssignmentInput(input) { return { ...input, training_id: input.trainings[0].training_id }; },
  async lockAssignmentPlanning(tx) { tx.events.push('lock'); },
  ASSIGNMENT_TRANSACTION_OPTIONS: { timeout: 30000, maxWait: 5000 }
};
function materialize(value) {
  if (Array.isArray(value)) return value.map(materialize);
  if (!value || typeof value !== 'object' || value instanceof Date) return value;
  if (value.create) return materialize(value.create);
  if (value.connect) return undefined;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, materialize(v)]).filter(([, v]) => v !== undefined));
}
function fake(options = {}) {
  const events = []; let rows = {}; let history = options.history || {};
  const users = [
    { id: 'client', email: 'cliente@exom.dev', role: 'CLIENT', firebase_uid: 'PRIVATE_UID', auth_provider: 'email', is_active: true, is_locked: false, is_archived: false, identity_pending: false, locked_at: null, profile: { user_id: 'client' } },
    { id: 'admin', email: 'superadmin@exom.dev', role: 'SUPER_ADMIN', firebase_uid: 'OTHER_PRIVATE_UID', auth_provider: 'email', is_active: true, is_locked: false, is_archived: false, identity_pending: false, locked_at: null, profile: { user_id: 'admin' } }
  ];
  if (options.badUser) Object.assign(users[0], options.badUser);
  const tx = { events, user: { findMany: async () => users }, autoAssignmentRule: { count: async () => options.rules || 0 } };
  for (const model of ['dayProgress', 'dietDaySnapshot', 'trainingDaySnapshot', 'rirProtectedDay', 'rirDayTarget', 'rirCycleVersion', 'progressOperation', 'feedbackMedia']) tx[model] = { count: async () => history[model] || 0 };
  for (const model of ['training', 'diet', 'exercise', 'trainingExercise', 'meal', 'ingredient', 'mealIngredient', 'planAssignmentTraining', 'planAssignment']) {
    tx[model] = {
      count: async () => options.collision === model ? 1 : 0,
      findFirst: async () => options.existing || rows.assignment || null,
      findUnique: async () => rows[model] || null,
      async create({ data }) {
        events.push(`write:${model}`);
        if (options.fail === model) throw Error('secret database details');
        rows[model] = materialize(data);
        if (model === 'planAssignment') rows.assignment = { ...rows[model], training_id: data.training.connect.id, diet_id: data.diet.connect.id, client_id: data.client.connect.id, admin_id: data.admin.connect.id };
        return rows[model];
      }
    };
  }
  const prisma = { ...tx, async $transaction(fn) {
    const before = structuredClone(rows);
    try { return await fn(tx); } catch (e) { rows = before; events.push('rollback'); throw e; }
  } };
  return { prisma, events, rows: () => rows, setHistory: value => { history = value; }, edit: fn => fn(rows), users };
}
function deps(f, extra = {}) {
  return { db: prismaAdapter(f.prisma, canonical), clock: async () => clocks(), project: { name: 'exom-api', branch: 'feat/progreso-adherencia-p4', base: 'f83a320cd4c7a63a071eb73bc17fac4f095232e7' }, status: async () => {}, ...extra };
}
test('clock and project fail closed; no date override', () => {
  assert.equal(guardClocks(clocks()), date);
  for (const key of Object.keys(clocks())) for (const field of ['local', 'utc', 'offset', 'zone']) {
    const c = clocks(); c[key][field] = 'invalid'; assert.throws(() => guardClocks(c));
  }
  assert.throws(() => guardClocks({}));
  assert.throws(() => guardProject({ name: 'production', branch: 'main' }));
});
test('deterministic plan has canonical single NEVER link, tracked REPS and consistent synthetic meals', () => {
  const p = fixturePlan(date, 'client', 'admin', canonical);
  assert.deepEqual(p, fixturePlan(date, 'client', 'admin', canonical));
  assert.equal(p.training.name, `TEST P4 Smoke ${date}`);
  assert.equal(p.assignment.training.connect.id, p.training.id);
  assert.equal(p.assignment.trainings.create.length, 1);
  assert.equal(p.assignment.trainings.create[0].training.connect.id, p.training.id);
  assert.equal(p.assignment.trainings.create[0].last_set_video_policy, 'NEVER');
  assert.equal(p.assignment.trainings.create[0].requires_last_set_video, false);
  for (const [i, e] of p.training.exercises.create.entries()) {
    assert.equal(e.order, i); assert.equal(e.sets, 2); assert.equal(e.measure_type, 'REPS');
    assert.equal(e.target_value, 10); assert.equal(e.reps_or_duration, '10');
    assert.equal(e.target_rir, 3); assert.equal(e.rest_seconds, 60); assert.equal(e.request_set_tracking, true);
    assert.equal(e.exercise.create.video_url, undefined);
  }
  assert.equal(p.diet.meals.create.length, 2);
  let calories = 0;
  for (const m of p.diet.meals.create) {
    assert.equal(m.parent_meal_id, undefined);
    const mi = m.ingredients.create[0]; const ing = mi.ingredient.create;
    assert.match(ing.name, /SYNTHETIC.*NOT NUTRITION ADVICE/);
    assert.equal(mi.unit, 'g'); assert.ok(mi.quantity > 0);
    assert.equal(m.calories, ing.calories_per_100g * mi.quantity / 100);
    for (const key of ['protein', 'carbs', 'fat']) assert.equal(m[`${key}_g`], ing[`${key}_per_100g`] * mi.quantity / 100);
    calories += m.calories;
  }
  assert.equal(p.diet.total_calories, calories); assert.ok(calories > 0);
});
test('dry run performs guarded reads only and no manifest', async () => {
  const f = fake(); let statuses = 0;
  const result = await provision(false, deps(f, { status: async () => statuses++ }));
  assert.equal(result.outcome, 'dry_run'); assert.equal(statuses, 0);
  assert.deepEqual(f.events, ['lock']); assert.deepEqual(f.rows(), {});
});
for (const options of [{ existing: { id: 'foreign' } }, { rules: 1 }, { badUser: { role: 'ADMIN' } }, { badUser: { profile: null } }, { badUser: { firebase_uid: '' } }, { badUser: { is_locked: true } }, ...['dayProgress', 'dietDaySnapshot', 'trainingDaySnapshot', 'rirProtectedDay', 'rirDayTarget', 'rirCycleVersion', 'progressOperation', 'feedbackMedia'].map(model => ({ history: { [model]: 1 } })), ...['training', 'diet', 'exercise', 'trainingExercise', 'meal', 'ingredient', 'mealIngredient', 'planAssignmentTraining', 'planAssignment'].map(collision => ({ collision }))]) {
  test(`collision blocks before any catalog write ${JSON.stringify(options)}`, async () => {
    const f = fake(options); await assert.rejects(provision(true, deps(f)));
    assert.ok(!f.events.some(e => e.startsWith('write:'))); assert.deepEqual(f.rows(), {});
  });
}
test('create then exact rerun preserves IDs, user history, and secret-free states', async () => {
  const f = fake(); const reports = [];
  const d = deps(f, { status: async r => reports.push(structuredClone(r)) });
  assert.equal((await provision(true, d)).outcome, 'created');
  const before = structuredClone(f.rows()); const writes = f.events.filter(e => e.startsWith('write:')).length;
  f.setHistory({ dayProgress: 1, feedbackMedia: 1, progressOperation: 1 });
  assert.equal((await provision(true, d)).outcome, 'unchanged');
  assert.deepEqual(f.rows(), before); assert.equal(f.events.filter(e => e.startsWith('write:')).length, writes);
  assert.deepEqual(reports.slice(0, 3).map(r => r.phase), ['intent', 'committed', 'readback']);
  assert.doesNotMatch(JSON.stringify(reports), /PRIVATE_UID|firebase|password|token|postgresql|secret/);
});
test('modified owned catalog or assigner blocks rerun without overwriting', async () => {
  for (const edit of [r => { r.training.name = 'user edit'; }, r => { r.assignment.admin_id = 'foreign'; }]) {
    const f = fake(); await provision(true, deps(f)); f.edit(edit);
    const before = structuredClone(f.rows()); await assert.rejects(provision(true, deps(f)));
    assert.deepEqual(f.rows(), before);
  }
});
test('second-half failure rolls back catalog and assignment; errors are sanitized', async () => {
  for (const fail of ['diet', 'planAssignment']) {
    const f = fake({ fail }); const reports = [];
    await assert.rejects(provision(true, deps(f, { status: async r => reports.push(r) })));
    assert.deepEqual(f.rows(), {}); assert.ok(f.events.includes('rollback'));
    assert.doesNotMatch(JSON.stringify(reports), /secret database details/);
  }
  assert.equal(safeCode(Error('secret')), 'OPERATION_FAILED');
});
test('clock re-evaluated under transaction before writes', async () => {
  const f = fake(); let n = 0;
  await assert.rejects(provision(true, deps(f, { clock: async () => { const c = clocks(); if (++n > 1) c.device.utc = '2026-10-01'; return c; } })));
  assert.ok(!f.events.some(e => e.startsWith('write:')));
});
test('import is SDK/connection free; container guard shared and strict', () => {
  const { validateContainer } = require('./provision-selected-synthetic-users.cjs');
  assert.throws(() => validateContainer({}));
  const loaded = Object.keys(require.cache).join('\n');
  assert.doesNotMatch(loaded, /firebase-admin|ts-node|adapter-pg|node_modules[\\/]pg[\\/]/);
});
