'use strict';

const { createHash } = require('node:crypto');

const NAMESPACE = 'exom:p4:smoke-fixtures:v1';
const BASE = 'f83a320cd4c7a63a071eb73bc17fac4f095232e7';
const SAFE_CODES = new Set([
  'INVALID_DATE', 'CLOCK_MISMATCH', 'PROJECT_MISMATCH',
  'INVALID_FIXTURE_INPUT', 'HELPER_INCOMPLETE', 'UNSAFE_CONTAINER',
]);

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function validDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

function fixtureId(date, key) {
  const bytes = createHash('sha1').update(`${NAMESPACE}\0${date}\0${key}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function guardClocks(clocks) {
  const date = clocks?.host?.local;
  if (!validDate(date)) fail('CLOCK_MISMATCH');
  for (const key of ['host', 'device', 'docker', 'database']) {
    const clock = clocks?.[key];
    if (!clock || clock.local !== date || clock.utc !== date ||
        clock.offset !== '+0000' || clock.zone !== 'GMT') fail('CLOCK_MISMATCH');
  }
  return date;
}

function guardProject(project) {
  if (project?.name !== 'exom-api' ||
      project.branch !== 'feat/progreso-adherencia-p4' || project.base !== BASE) {
    fail('PROJECT_MISMATCH');
  }
  return project;
}

function safeCode(error) {
  return typeof error?.code === 'string' && SAFE_CODES.has(error.code)
    ? error.code : 'OPERATION_FAILED';
}

function fixturePlan(date, clientId, adminId, canonical) {
  if (!validDate(date)) fail('INVALID_DATE');
  if (typeof clientId !== 'string' || !clientId.trim() ||
      typeof adminId !== 'string' || !adminId.trim() ||
      typeof canonical?.normalizeAssignmentInput !== 'function') fail('INVALID_FIXTURE_INPUT');
  const id = key => fixtureId(date, key);
  const training = {
    id: id('training'), name: `TEST P4 Smoke ${date}`, type: 'TEST', tags: ['TEST', 'P4'],
    exercises: { create: [0, 1].map(order => ({
      id: id(`training-exercise:${order}`), order, sets: 2, measure_type: 'REPS',
      target_value: 10, reps_or_duration: '10', target_rir: 3, rest_seconds: 60,
      request_set_tracking: true,
      exercise: { create: {
        id: id(`exercise:${order}`), name: `TEST P4 Smoke ${date} Exercise ${order + 1}`,
        muscle_groups: [], equipment: [],
      } },
    })) },
  };
  // Artificial arithmetic-only fixtures; these are not nutritional recommendations.
  const meals = [0, 1].map(order => {
    const quantity = 100 * (order + 1);
    const ingredient = {
      id: id(`ingredient:${order}`),
      name: `TEST P4 Smoke ${date} SYNTHETIC NOT NUTRITION ADVICE ${order + 1}`,
      calories_per_100g: 100, protein_per_100g: 5, carbs_per_100g: 11, fat_per_100g: 4,
    };
    return {
      id: id(`meal:${order}`), type: order === 0 ? 'BREAKFAST' : 'LUNCH',
      name: `TEST P4 Smoke ${date} Synthetic Meal ${order + 1}`, order, nutritional_badges: [],
      calories: ingredient.calories_per_100g * quantity / 100,
      protein_g: ingredient.protein_per_100g * quantity / 100,
      carbs_g: ingredient.carbs_per_100g * quantity / 100,
      fat_g: ingredient.fat_per_100g * quantity / 100,
      ingredients: { create: [{
        id: id(`meal-ingredient:${order}`), quantity, unit: 'g', grams_equivalent: quantity,
        ingredient: { create: ingredient },
      }] },
    };
  });
  const diet = {
    id: id('diet'), name: `TEST P4 Smoke ${date} SYNTHETIC NOT NUTRITION ADVICE`,
    tags: ['TEST', 'P4'], meals: { create: meals },
    total_calories: meals.reduce((sum, meal) => sum + meal.calories, 0),
    total_protein_g: meals.reduce((sum, meal) => sum + meal.protein_g, 0),
    total_carbs_g: meals.reduce((sum, meal) => sum + meal.carbs_g, 0),
    total_fat_g: meals.reduce((sum, meal) => sum + meal.fat_g, 0),
  };
  const normalized = canonical.normalizeAssignmentInput({
    trainings: [{ training_id: training.id, last_set_video_policy: 'NEVER', requires_last_set_video: false }],
    diet_id: diet.id, is_rest_day: false,
  });
  if (normalized?.training_id !== training.id || normalized.diet_id !== diet.id ||
      normalized.is_rest_day !== false || normalized.trainings?.length !== 1 ||
      normalized.trainings[0].training_id !== training.id ||
      normalized.trainings[0].last_set_video_policy !== 'NEVER') fail('INVALID_FIXTURE_INPUT');
  const assignment = {
    id: id('assignment'), date: new Date(`${date}T00:00:00.000Z`), is_rest_day: false,
    client: { connect: { id: clientId } }, admin: { connect: { id: adminId } },
    training: { connect: { id: normalized.training_id } }, diet: { connect: { id: normalized.diet_id } },
    trainings: { create: [{
      id: id('assignment-training'), position: 0,
      training: { connect: { id: training.id } },
      last_set_video_policy: 'NEVER', requires_last_set_video: false,
    }] },
  };
  return { training, diet, assignment };
}

function prismaAdapter(prisma, canonical) {
  const emails = ['cliente@exom.dev', 'superadmin@exom.dev'];
  const userQuery = { where: { email: { in: emails } }, select: {
    id: true, email: true, role: true, firebase_uid: true, auth_provider: true,
    is_active: true, is_locked: true, is_archived: true, identity_pending: true,
    locked_at: true, profile: { select: { user_id: true } },
  } };
  function actors(users) {
    const pair = emails.map(email => users.filter(user => user.email === email));
    if (users.length !== 2 || pair.some(matches => matches.length !== 1)) fail('INVALID_FIXTURE_INPUT');
    const [client, admin] = pair.map(matches => matches[0]);
    for (const [user, role] of [[client, 'CLIENT'], [admin, 'SUPER_ADMIN']]) {
      if (user.role !== role || !user.id || !user.firebase_uid || user.auth_provider !== 'email' ||
          user.is_active !== true || user.is_locked !== false || user.is_archived !== false ||
          user.identity_pending !== false || user.locked_at !== null || user.profile?.user_id !== user.id) {
        fail('INVALID_FIXTURE_INPUT');
      }
    }
    if (client.id === admin.id || client.firebase_uid === admin.firebase_uid) fail('INVALID_FIXTURE_INPUT');
    return { client, admin };
  }
  // Compare prescribed fields, not timestamps/default-generated columns. Relation
  // creates become read arrays/objects; connects become actual foreign-key fields.
  function equalData(actual, expected) {
    if (expected instanceof Date) {
      return (actual instanceof Date ? actual.toISOString() : actual) === expected.toISOString();
    }
    if (Array.isArray(expected)) {
      return Array.isArray(actual) && actual.length === expected.length &&
        expected.every((value, index) => equalData(actual[index], value));
    }
    if (!expected || typeof expected !== 'object') return actual === expected;
    if (!actual || typeof actual !== 'object') return false;
    return Object.entries(expected).every(([key, value]) => {
      if (value?.create) return equalData(actual[key], value.create);
      if (value?.connect) {
        // Minimal injected fakes omit connected relations; Prisma exposes the FK.
        const foreignKey = `${key}_id`;
        return foreignKey in actual ? actual[foreignKey] === value.connect.id :
          !(key in actual) || actual[key]?.id === value.connect.id;
      }
      return equalData(actual[key], value);
    });
  }
  const trainingInclude = { exercises: { orderBy: { order: 'asc' }, include: { exercise: true } }, blocks: true };
  const dietInclude = { meals: { orderBy: [{ order: 'asc' }, { id: 'asc' }],
    include: { ingredients: { orderBy: { id: 'asc' }, include: { ingredient: true } } } } };
  const assignmentInclude = { trainings: { orderBy: { position: 'asc' } } };
  function untouched(row, defaults) {
    return row && Object.entries(defaults).every(([key, value]) => !(key in row) || equalData(row[key], value));
  }
  async function readOwned(tx, plan, existing) {
    const training = await tx.training.findUnique({ where: { id: plan.training.id }, include: trainingInclude });
    const diet = await tx.diet.findUnique({ where: { id: plan.diet.id }, include: dietInclude });
    if (!equalData(existing, plan.assignment) ||
        !untouched(existing, { auto_assignment_rule_id: null, notes: null }) ||
        !equalData(training, plan.training) || !equalData(diet, plan.diet) ||
        !untouched(training, { is_active: true, blocks: [], rir_proposal: null, group_id: null,
          types: [], accentColor: null, level: 'PRINCIPIANTE', estimated_duration_min: null,
          estimated_calories: null, total_volume: null, warmup_description: null,
          warmup_duration_min: null, cooldown_description: null, created_by: null }) ||
        !untouched(diet, { is_active: true, group_id: null, created_by: null }) ||
        !training.exercises.every(item => untouched(item, { block_id: null, timed_config: null,
          rir_override: null, position_in_block: null, target_value_min: null, target_value_max: null }) &&
          untouched(item.exercise, { is_active: true, video_url: null, video_stream_id: null,
            thumbnail_url: null, level: 'PRINCIPIANTE', technique_text: null, common_errors_text: null,
            explanation_text: null, created_by: null })) ||
        !diet.meals.every(meal => untouched(meal, { parent_meal_id: null, image_url: null }) &&
          meal.ingredients.every(item => untouched(item.ingredient, { is_active: true, icon: null, created_by: null }))) ||
        !existing.trainings.every(link => untouched(link, { legacy_video_exempt: false }))) fail('INVALID_FIXTURE_INPUT');
  }
  async function run(date, clock, apply, intent) {
    return prisma.$transaction(async tx => {
      const initial = actors(await tx.user.findMany(userQuery));
      await canonical.lockAssignmentPlanning(tx, initial.client.id);
      if (guardClocks(await clock()) !== date) fail('CLOCK_MISMATCH');
      const { client, admin } = actors(await tx.user.findMany(userQuery));
      if (client.id !== initial.client.id || admin.id !== initial.admin.id) fail('INVALID_FIXTURE_INPUT');
      const plan = fixturePlan(date, client.id, admin.id, canonical);
      const report = { date, ids: { training: plan.training.id, diet: plan.diet.id, assignment: plan.assignment.id },
        counts: { trainings: 1, exercises: 2, diets: 1, meals: 2, ingredients: 2, links: 1 },
        actors: [{ email: client.email, role: client.role }, { email: admin.email, role: admin.role }] };
      const existing = await tx.planAssignment.findFirst({
        where: { client_id: client.id, date: plan.assignment.date }, include: assignmentInclude,
      });
      if (await tx.autoAssignmentRule.count({ where: { client_id: client.id, is_active: true } })) fail('INVALID_FIXTURE_INPUT');
      if (existing) {
        await readOwned(tx, plan, existing);
        return { ...report, outcome: 'unchanged' };
      }
      // Reject any history for this client: cycles have no date, receipts use
      // owner_id, and evidence uses assignment_date rather than date.
      for (const model of ['dayProgress', 'dietDaySnapshot', 'trainingDaySnapshot', 'rirProtectedDay',
        'rirDayTarget', 'rirCycleVersion', 'progressOperation', 'feedbackMedia']) {
        const where = model === 'progressOperation' ? { owner_id: client.id } : { client_id: client.id };
        if (await tx[model].count({ where })) fail('INVALID_FIXTURE_INPUT');
      }
      const ids = {
        training: [plan.training.id], diet: [plan.diet.id], planAssignment: [plan.assignment.id],
        trainingExercise: plan.training.exercises.create.map(item => item.id),
        exercise: plan.training.exercises.create.map(item => item.exercise.create.id),
        meal: plan.diet.meals.create.map(item => item.id),
        mealIngredient: plan.diet.meals.create.flatMap(meal => meal.ingredients.create.map(item => item.id)),
        ingredient: plan.diet.meals.create.flatMap(meal => meal.ingredients.create.map(item => item.ingredient.create.id)),
        planAssignmentTraining: plan.assignment.trainings.create.map(item => item.id),
      };
      for (const [model, values] of Object.entries(ids)) {
        if (await tx[model].count({ where: { id: { in: values } } })) fail('INVALID_FIXTURE_INPUT');
      }
      if (!apply) return { ...report, outcome: 'dry_run' };
      await intent(report);
      await tx.training.create({ data: plan.training });
      await tx.diet.create({ data: plan.diet });
      await tx.planAssignment.create({ data: plan.assignment });
      const created = await tx.planAssignment.findFirst({
        where: { client_id: client.id, date: plan.assignment.date }, include: assignmentInclude,
      });
      await readOwned(tx, plan, created);
      return { ...report, outcome: 'created' };
    }, { ...canonical.ASSIGNMENT_TRANSACTION_OPTIONS, isolationLevel: 'Serializable' });
  }
  return { run };
}

async function provision(apply, deps) {
  let report;
  let intended = false;
  let committed = false;
  try {
    if (typeof apply !== 'boolean' || typeof deps?.db?.run !== 'function' ||
        typeof deps.clock !== 'function' || typeof deps.status !== 'function') fail('INVALID_FIXTURE_INPUT');
    guardProject(deps.project);
    const date = guardClocks(await deps.clock());
    report = await deps.db.run(date, deps.clock, apply, async value => {
      report = value;
      await deps.status({ ...report, phase: 'intent' });
      intended = true;
    });
    if (!apply) return { ...report, outcome: 'dry_run' };
    committed = true;
    await deps.status({ ...report, phase: 'committed' });
    const readback = await deps.db.run(date, deps.clock, false, async () => fail('INVALID_FIXTURE_INPUT'));
    if (readback.outcome !== 'unchanged') fail('INVALID_FIXTURE_INPUT');
    await deps.status({ ...report, phase: 'readback' });
    return report;
  } catch (error) {
    const code = safeCode(error);
    if (intended || committed) {
      // Transaction rejection can be a lost commit acknowledgement. Never claim
      // absence, expose the driver error, or delete data as compensation.
      try { await deps.status({ ...report, phase: 'failed', durability: committed ? 'committed' : 'unknown', code }); }
      catch { /* Preserve the original sanitized failure if reporting also fails. */ }
    }
    const sanitized = new Error(code);
    sanitized.code = code;
    throw sanitized;
  }
}

module.exports = { fixturePlan, guardClocks, guardProject, safeCode, prismaAdapter, provision };

async function main() {
  // Runtime dependencies and private connection metadata exist only in this CLI child.
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const { randomUUID } = require('node:crypto');
  const execute = require('node:util').promisify(require('node:child_process').execFile);
  const aliases = ['TEST_DATABASE_URL', 'DATABASE_URL', 'DIRECT_URL', 'PRISMA_DATABASE_URL'];
  const previous = new Map([...aliases, 'DEBUG'].map(key => [key, process.env[key]]));
  let pool, prisma, manifest;
  let phase = 'arguments';
  let intentRecorded = false;
  let operationFailed = false;
  async function capture(file, args, cwd) {
    const { stdout } = await execute(file, args, {
      cwd, encoding: 'buffer', timeout: 5000, maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    try { return stdout.toString('utf8').trim(); }
    finally { stdout.fill(0); }
  }
  const utcZone = zone => ['UTC', 'GMT', 'Etc/UTC', 'Etc/GMT'].includes(zone);
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && args[0] !== '--apply')) fail('INVALID_FIXTURE_INPUT');
    const apply = args.length === 1;
    phase = 'project';
    const root = fs.realpathSync(path.resolve(__dirname, '..'));
    const actualRoot = fs.realpathSync(await capture('git', ['rev-parse', '--show-toplevel'], root));
    if (actualRoot !== root) fail('PROJECT_MISMATCH');
    const project = guardProject({ name: path.basename(root),
      branch: await capture('git', ['branch', '--show-current'], root), base: BASE });
    // BASE identifies the reviewed account helper, not a requirement to discard later commits.
    try { await capture('git', ['merge-base', '--is-ancestor', BASE, 'HEAD'], root); }
    catch { fail('PROJECT_MISMATCH'); }
    const currentCommit = await capture('git', ['rev-parse', 'HEAD'], root);
    if (!/^[a-f0-9]{40}$/.test(currentCommit)) fail('PROJECT_MISMATCH');
    phase = 'container';
    const containers = JSON.parse(await capture('docker', ['inspect', 'exom-p4-t1-ci-20260928'], root));
    if (!Array.isArray(containers) || containers.length !== 1) fail('UNSAFE_CONTAINER');
    const url = require('./provision-selected-synthetic-users.cjs').validateContainer(containers[0]);
    for (const key of aliases) process.env[key] = url;
    // Suppress inherited dependency debug logging before loading any DB runtime.
    process.env.DEBUG = '';
    phase = 'database_guard';
    pool = new (require('pg').Pool)({ connectionString: url, ssl: false,
      connectionTimeoutMillis: 3000, options: '-c search_path=public' });
    // Never allow an idle driver error to print connection information.
    pool.on('error', () => {});
    await require('./test-database.cjs').assertTestDatabase(pool);
    phase = 'canonical_sources';
    // Explicit project and type checking avoid dependence on the invocation CWD
    // or inherited transpile-only/ignored-diagnostic settings. No compiler output.
    require('ts-node').register({ project: path.join(root, 'tsconfig.json'),
      transpileOnly: false, typeCheck: true, ignoreDiagnostics: [], logError: false,
      skipProject: false, swc: false, emit: false });
    const canonical = {
      normalizeAssignmentInput: require(path.join(root, 'src/modules/assignments/assignment-input.ts')).normalizeAssignmentInput,
      ...require(path.join(root, 'src/modules/assignments/assignment-planning-lock.ts')),
    };
    const { PrismaClient } = require('@prisma/client');
    const { PrismaPg } = require('@prisma/adapter-pg');
    // Installed adapter leaves an externally supplied pool owned by this CLI.
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema: 'public', disposeExternalPool: false }), log: [] });
    const adb = path.join(os.homedir(), 'AppData', 'Local', 'Android', 'Sdk', 'platform-tools', 'adb.exe');
    async function clock() {
      // A separate pool statement is fresh even while the Prisma transaction is
      // holding its planning lock; transaction_timestamp()/now() is not used.
      const [deviceDate, deviceUtc, deviceOffset, deviceZone, dockerLocal, dockerUtc, database] = await Promise.all([
        capture(adb, ['-s', 'emulator-5554', 'shell', 'date', '+%Y-%m-%d'], root),
        capture(adb, ['-s', 'emulator-5554', 'shell', 'date', '-u', '+%Y-%m-%d'], root),
        capture(adb, ['-s', 'emulator-5554', 'shell', 'date', '+%z'], root),
        capture(adb, ['-s', 'emulator-5554', 'shell', 'getprop', 'persist.sys.timezone'], root),
        capture('docker', ['exec', 'exom-p4-t1-ci-20260928', 'date', '+%Y-%m-%d|%z|%Z'], root),
        capture('docker', ['exec', 'exom-p4-t1-ci-20260928', 'date', '-u', '+%Y-%m-%d'], root),
        pool.query(`WITH clock AS MATERIALIZED (SELECT clock_timestamp() AS instant)
          SELECT to_char(instant, 'YYYY-MM-DD') AS local,
            to_char(instant AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS utc,
            extract(timezone FROM instant)::integer AS offset_seconds,
            current_setting('TimeZone') AS zone,
            (SELECT reset_val FROM pg_settings WHERE name = 'TimeZone') AS server_zone
          FROM clock`),
      ]);
      const [dockerDate, dockerOffset, dockerZone] = dockerLocal.split('|');
      const row = database.rows[0];
      // This is the API's normalized UTC host VIEW, not the physical host zone.
      const hostDate = new Date().toISOString().slice(0, 10);
      const clocks = {
        host: { local: hostDate, utc: hostDate, offset: '+0000', zone: 'GMT', basis: 'UTC' },
        device: { local: deviceDate, utc: deviceUtc, offset: deviceOffset, zone: deviceZone },
        docker: { local: dockerDate, utc: dockerUtc, offset: dockerOffset,
          zone: dockerOffset === '+0000' && utcZone(dockerZone) ? 'GMT' : dockerZone },
        database: { local: row?.local, utc: row?.utc,
          offset: row?.offset_seconds === 0 ? '+0000' : 'invalid',
          zone: row?.offset_seconds === 0 && utcZone(row?.zone) && utcZone(row?.server_zone) ? 'GMT' : 'invalid' },
      };
      guardClocks(clocks);
      return clocks;
    }
    phase = 'clock_guard';
    guardClocks(await clock());
    let directory;
    if (apply) {
      phase = 'manifest';
      directory = path.join(os.tmpdir(), `exom-p4-smoke-fixtures-${randomUUID()}`);
      fs.mkdirSync(directory, { mode: 0o700 });
      directory = fs.realpathSync(directory);
      manifest = path.join(directory, 'status.json');
    }
    const status = async report => {
      if (!apply || !directory) fail('INVALID_FIXTURE_INPUT');
      const owner = fs.lstatSync(directory);
      if (!owner.isDirectory() || owner.isSymbolicLink() || fs.realpathSync(directory) !== directory) fail('INVALID_FIXTURE_INPUT');
      if (fs.existsSync(manifest)) {
        const existing = fs.lstatSync(manifest);
        if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1) fail('INVALID_FIXTURE_INPUT');
      }
      const pending = path.join(directory, 'status.pending');
      const fd = fs.openSync(pending, 'wx', 0o600);
      try {
        fs.fchmodSync(fd, 0o600);
        fs.writeFileSync(fd, JSON.stringify({ base: BASE, currentCommit, namespace: NAMESPACE, ...report }, null, 2) + '\n');
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      fs.renameSync(pending, manifest);
      if (report.phase === 'intent') intentRecorded = true;
    };
    phase = 'provision';
    const result = await provision(apply, { project, db: prismaAdapter(prisma, canonical), clock, status });
    phase = 'complete';
    process.stdout.write(`${result.date} ${result.outcome} ${JSON.stringify(result.counts)}\n`);
    if (manifest) process.stdout.write(`Status manifest: ${manifest}\n`);
  } catch (error) {
    operationFailed = true;
    process.stderr.write(`${intentRecorded ? 'FAILED' : 'NOT_RUN'} ${safeCode(error)} ${phase}\n`);
    if (manifest) process.stderr.write(`Status manifest: ${manifest}\n`);
    process.exitCode = 1;
  } finally {
    let cleanupFailed = false;
    try { if (prisma) await prisma.$disconnect(); }
    catch { cleanupFailed = true; }
    try { if (pool && !pool.ended) await pool.end(); }
    catch { cleanupFailed = true; }
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (cleanupFailed && !operationFailed) {
      process.stderr.write('FAILED OPERATION_FAILED disconnect\n');
      process.exitCode = 1;
    }
  }
}

if (require.main === module) main().catch(error => {
  process.stderr.write(`NOT_RUN ${safeCode(error)} bootstrap\n`);
  process.exitCode = 1;
});
