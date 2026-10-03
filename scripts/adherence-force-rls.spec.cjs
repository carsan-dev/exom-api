'use strict';
// Explicit opt-in only. Never discover .env or inherit a database URL alias.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { Client } = require('pg');
const root = path.resolve(__dirname, '..');
const migrations = path.join(root, 'prisma/migrations');
const names = fs.readdirSync(migrations).filter(n => fs.existsSync(path.join(migrations, n, 'migration.sql'))).sort();
const sources = ['catalog_colors', 'diet_groups', 'diets', 'exercises', 'ingredients',
  'meal_ingredients', 'meals', 'plan_assignment_trainings', 'plan_assignments',
  'training_blocks', 'training_exercises', 'training_groups', 'trainings'];
const overlays = ['diet_day_snapshots', 'rir_day_targets', 'training_day_snapshots'];
const forced = ['diets', 'exercises', 'ingredients', 'meal_ingredients', 'meals',
  'plan_assignments', 'training_exercises', 'trainings'];
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const sql = i => fs.readFileSync(path.join(migrations, names[i - 1], 'migration.sql'), 'utf8');
const readOnlyEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) =>
  /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|SYSTEMDRIVE|COMSPEC|PROGRAMFILES(?:\(X86\))?|PROGRAMW6432|COMMONPROGRAMFILES(?:\(X86\))?|COMMONPROGRAMW6432|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|OS)$/i.test(k)));

function configuration() {
  const uri = process.env.TEST_FORCE_RLS_DATABASE_URL;
  const nonce = process.env.TEST_FORCE_RLS_NONCE;
  assert.ok(uri && nonce, 'Explicit TEST_FORCE_RLS_DATABASE_URL and nonce required; no fallback');
  assert.match(nonce, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const u = new URL(uri);
  assert.equal(u.protocol, 'postgresql:'); assert.equal(u.hostname, '127.0.0.1');
  assert.ok(Number(u.port) > 0 && u.port !== '55493');
  assert.equal(u.username, 'exom_force_admin'); assert.equal(u.password, '');
  assert.equal(u.pathname, '/exom_force_admin'); assert.equal(u.search, '');
  const own = path.resolve(process.env.TEST_FORCE_RLS_ARTIFACT_DIR || '');
  assert.equal(own.toLowerCase(), path.resolve('C:/Users/croly/AppData/Local/Temp/exom-force-rls-' + nonce).toLowerCase());
  const id = process.env.TEST_FORCE_RLS_CONTAINER_ID;
  assert.match(id || '', /^[0-9a-f]{64}$/);
  const docker = 'C:/Program Files/Docker/Docker/resources/bin/docker.exe';
  const guard = () => {
    const r = spawnSync(docker, ['inspect', id], { env: readOnlyEnv(), shell: false, encoding: 'utf8' });
    assert.equal(r.status, 0, 'Owned container inspection required');
    const c = JSON.parse(r.stdout)[0];
    assert.equal(c.Id, id); assert.equal(c.Name, '/exom-force-rls-' + nonce);
    assert.equal(c.Config.Image, 'postgres:17');
    assert.equal(c.Config.Labels['exom.force-rls.nonce'], nonce);
    assert.ok(c.Config.Env.includes('PGDATA=/var/lib/postgresql/exom-force-rls'));
    assert.ok(c.HostConfig.Tmpfs['/var/lib/postgresql/exom-force-rls']);
    assert.equal(c.HostConfig.AutoRemove, true);
    assert.deepEqual(c.NetworkSettings.Ports['5432/tcp'], [{ HostIp: '127.0.0.1', HostPort: u.port }]);
  };
  guard();
  return { uri, nonce, own, id, guard };
}

// Preserve complete rows, not hand-picked JSON fields or just total counts.
async function images(c, tables) {
  const result = {};
  for (const table of tables) result[table] = (await c.query(`SELECT to_jsonb(s) image FROM public.${table} s ORDER BY to_jsonb(s)::text`)).rows.map(r => r.image);
  return result;
}
async function security(c) {
  return (await c.query(`SELECT c.relname,c.relowner,c.relrowsecurity,c.relforcerowsecurity,c.relacl,
    (SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.polname),'[]'::jsonb) FROM pg_policy p WHERE p.polrelid=c.oid) policies
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname=ANY($1::text[]) ORDER BY c.relname`, [[...sources, ...overlays]])).rows;
}
async function seed(c) {
  await c.query(`
    INSERT INTO users(id,email,firebase_uid,updated_at) VALUES ('fixture-client','force-rls@example.invalid','synthetic-force-rls',now());
    INSERT INTO catalog_colors(id,catalog_type,normalized_key,value,color,updated_at) VALUES ('color','training_type','fixture','fixture','#123456',now());
    INSERT INTO training_groups(id,name,normalized_name,updated_at) VALUES ('tg','Fixture','fixture',now());
    INSERT INTO diet_groups(id,name,normalized_name,updated_at) VALUES ('dg','Fixture','fixture',now());
    INSERT INTO trainings(id,name,type,types,tags,group_id,updated_at) VALUES ('training','Fixture','fixture',ARRAY['fixture'],ARRAY['test'],'tg',now());
    INSERT INTO training_blocks(id,training_id,"order",updated_at) VALUES ('block','training',0,now());
    INSERT INTO exercises(id,name,muscle_groups,equipment,updated_at) VALUES ('exercise','Fixture',ARRAY['test'],ARRAY['test'],now());
    INSERT INTO training_exercises(id,training_id,exercise_id,block_id,"order",sets,reps_or_duration,target_rir) VALUES ('te','training','exercise','block',0,3,'10',2);
    INSERT INTO diets(id,name,group_id,updated_at) VALUES ('diet','Fixture','dg',now());
    INSERT INTO meals(id,diet_id,type,name,nutritional_badges,updated_at) VALUES ('meal','diet','BREAKFAST','Fixture',ARRAY['test'],now());
    INSERT INTO ingredients(id,name,calories_per_100g,protein_per_100g,carbs_per_100g,fat_per_100g,updated_at) VALUES ('ingredient','Fixture',100,10,10,2,now());
    INSERT INTO meal_ingredients(id,meal_id,ingredient_id,quantity) VALUES ('mi','meal','ingredient',125);
    INSERT INTO diet_day_snapshots(client_id,date,diet_id,provenance,diet) VALUES ('fixture-client','2026-10-01','diet','observed','{"id":"diet","meals":[{"id":"meal","grams":125}]}'::jsonb);
    INSERT INTO training_day_snapshots(client_id,date,training_id,payload) VALUES ('fixture-client','2026-10-01','training','{"id":"training","exercises":[{"id":"te","sets":3,"reps":10}]}'::jsonb);
    INSERT INTO rir_day_targets(client_id,date,training_exercise_id,training_id,target_rir) VALUES ('fixture-client','2026-10-01','te','training',2);
    INSERT INTO plan_assignments(id,client_id,date,training_id,diet_id,updated_at) VALUES ('assignment','fixture-client','2026-10-01','training','diet',now());
    INSERT INTO plan_assignment_trainings(id,assignment_id,training_id,position) VALUES ('link','assignment','training',0);
  `);
}

async function assertCapture(c, expected, epoch, effective) {
  for (const [table, rows] of Object.entries(expected)) {
    const actual = (await c.query('SELECT row_image FROM adherence_history_baselines WHERE epoch_id=$1 AND source_table=$2 ORDER BY row_image::text', [epoch, table])).rows.map(r => r.row_image);
    assert.deepEqual(actual, rows, 'Full row images: ' + table);
    assert.ok(rows.length > 0, 'Nonempty representative source: ' + table);
  }
  const e = (await c.query('SELECT sequence_boundary FROM adherence_history_epochs WHERE id=$1', [epoch])).rows[0];
  const seq = (await c.query("SELECT pg_get_serial_sequence('public.adherence_assignment_journal','event_sequence') seq")).rows[0].seq;
  const value = (await c.query(`SELECT last_value FROM ${seq}`)).rows[0].last_value;
  assert.equal(e.sequence_boundary, value, 'Actual qualified allocator boundary');
  if (effective) {
    assert.equal((await c.query('SELECT public.adherence_has_effective_coverage($1) covered', [epoch])).rows[0].covered, true);
    const marker = (await c.query("SELECT row_image FROM adherence_history_baselines WHERE epoch_id=$1 AND source_table='__adherence_coverage__'", [epoch])).rows[0].row_image;
    assert.equal(marker.sources.length, 16);
    assert.deepEqual(marker.counts, Object.fromEntries(Object.entries(expected).map(([k, v]) => [k, v.length])));
  }
}

test('PG17 effective owner visibility preserves FORCE RLS and complete 13/16 captures', { timeout: 240000 }, async t => {
  const cfg = configuration();
  assert.equal(names.length, 91); assert.equal(names[84], '20261001040000_adherence_history_baseline');
  const run = crypto.randomUUID().replaceAll('-', '');
  const dir = path.join(cfg.own, 'run-' + run); fs.mkdirSync(dir);
  const receipt = { nonce: cfg.nonce, containerId: cfg.id, commands: [], checks: [], migrationHashes: Object.fromEntries(names.map(n => [n, sha(fs.readFileSync(path.join(migrations, n, 'migration.sql')))])) };
  const clients = [];
  const connect = async (uri, database, role) => {
    cfg.guard(); const c = new Client({ connectionString: uri, connectionTimeoutMillis: 3000 });
    await c.connect(); clients.push(c);
    const x = (await c.query(`SELECT current_database() db,current_user role,current_setting('server_version_num')::int version,
      current_setting('data_directory') dir,shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()`)).rows[0];
    assert.equal(x.db, database); assert.equal(x.role, role);
    assert.ok(x.version >= 170000 && x.version < 180000);
    assert.equal(x.dir, '/var/lib/postgresql/exom-force-rls'); assert.equal(x.marker, 'exom-force-rls:' + cfg.nonce);
    return c;
  };
  const admin = await connect(cfg.uri, 'exom_force_admin', 'exom_force_admin');
  const fixture = async label => {
    cfg.guard(); const role = 'force_' + label + '_' + run, db = role;
    await admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER BYPASSRLS`);
    await admin.query(`GRANT pg_read_all_settings TO ${role}`);
    await admin.query(`CREATE DATABASE ${db} OWNER ${role} TEMPLATE template0`);
    await admin.query(`COMMENT ON DATABASE ${db} IS 'exom-force-rls:${cfg.nonce}'`);
    const u = new URL(cfg.uri); u.username = role; u.pathname = '/' + db;
    const c = await connect(u.toString(), db, role);
    const priv = (await c.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
    assert.deepEqual(priv, { rolsuper: false, rolbypassrls: true });
    return { c, uri: u.toString(), role, db };
  };
  const deploy = (f, count, label, override, args = ['migrate', 'deploy']) => {
    cfg.guard();
    const d = path.join(dir, label); fs.mkdirSync(d); const m = path.join(d, 'migrations'); fs.mkdirSync(m);
    fs.copyFileSync(path.join(root, 'prisma/schema.prisma'), path.join(d, 'schema.prisma'));
    fs.copyFileSync(path.join(migrations, 'migration_lock.toml'), path.join(m, 'migration_lock.toml'));
    for (const n of names.slice(0, count)) { fs.mkdirSync(path.join(m, n)); fs.writeFileSync(path.join(m, n, 'migration.sql'), override && n === names[84] ? override : fs.readFileSync(path.join(migrations, n, 'migration.sql'))); }
    const config = path.join(d, 'prisma.config.js');
    fs.writeFileSync(config, `module.exports={schema:${JSON.stringify(path.join(d, 'schema.prisma'))},migrations:{path:${JSON.stringify(m)}},datasource:{url:process.env.TEST_FORCE_RLS_DATABASE_URL}};`);
    const env = { ...readOnlyEnv(), TEST_FORCE_RLS_DATABASE_URL: f.uri, TEMP: dir, TMP: dir, TMPDIR: dir, JITI_CACHE: dir, CACHE_DIR: dir, NODE_DISABLE_COMPILE_CACHE: '1', CHECKPOINT_DISABLE: '1' };
    const command = [require.resolve('prisma/build/index.js'), ...args, '--config', config];
    const r = spawnSync(process.execPath, command, { cwd: d, env, shell: false, encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
    const text = ((r.stdout || '') + (r.stderr || '')).replace(/postgres(?:ql)?:\/\/[^\s"']+/g, '[LOCAL_URI]');
    fs.writeFileSync(path.join(d, 'prisma.log'), text);
    receipt.commands.push({ args, count, label, exit: r.status });
    return { status: r.status, text };
  };
  const prepare = async (f, force = true) => {
    const r = deploy(f, 84, f.db + '-prefix'); assert.equal(r.status, 0, r.text);
    await seed(f.c);
    if (force) for (const table of forced) await f.c.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${table} FORCE ROW LEVEL SECURITY; CREATE POLICY deny_fixture ON ${table} AS RESTRICTIVE FOR ALL TO PUBLIC USING (false) WITH CHECK (false)`);
    return { rows: await images(f.c, [...sources, ...overlays]), sec: await security(f.c) };
  };
  try {
    await t.test('baseline85, activation87, upgrade90 and final91 with forced sources', async sub => {
      const f = await fixture('upgrade'), before = await prepare(f);
      assert.equal(before.sec.filter(r => r.relforcerowsecurity).length, 8);
      let directError;
      try { await f.c.query(sql(85).replace(/COMMIT;\s*$/, 'ROLLBACK;')); }
      catch (e) { directError = e; await f.c.query('ROLLBACK'); }
      assert.equal((await f.c.query("SELECT to_regclass('public.adherence_history_epochs') e,to_regclass('public.adherence_history_baselines') b")).rows[0].e, null);
      assert.equal((await f.c.query("SELECT to_regclass('public.adherence_history_baselines') b")).rows[0].b, null);
      assert.deepEqual(await images(f.c, [...sources, ...overlays]), before.rows);
      receipt.checks.push({ case: 'direct85', sqlstate: directError?.code || 'accepted', message: directError?.message || 'complete capture transaction rolled back for probe' });
      assert.equal(directError?.code, undefined, 'Legitimate nonsuperuser BYPASSRLS owner: ' + directError?.message);
      const result = deploy(f, 85, 'baseline85');
      assert.equal(result.status, 0, 'Legitimate nonsuperuser BYPASSRLS owner must capture FORCE RLS sources: ' + result.text);
      const first = (await f.c.query('SELECT id FROM adherence_history_epochs')).rows[0].id;
      await assertCapture(f.c, Object.fromEntries(sources.map(n => [n, before.rows[n]])), first, false);
      const original = (await f.c.query('SELECT * FROM adherence_history_baselines WHERE epoch_id=$1 ORDER BY source_table,row_key', [first])).rows;
      assert.equal(deploy(f, 87, 'activation87').status, 0);
      const second = (await f.c.query('SELECT * FROM public.activate_adherence_history_origin()')).rows[0].id;
      await assertCapture(f.c, Object.fromEntries(sources.map(n => [n, before.rows[n]])), second, false);
      await admin.query(`ALTER ROLE ${f.role} NOBYPASSRLS`);
      await assert.rejects(f.c.query('SELECT * FROM public.activate_adherence_history_origin()'), e => e.code === '42501');
      await admin.query(`ALTER ROLE ${f.role} BYPASSRLS`);
      // Exercise all three overlay full-visibility guards, not only the eight production-like sources.
      for (const table of overlays) await f.c.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${table} FORCE ROW LEVEL SECURITY; CREATE POLICY deny_fixture ON ${table} AS RESTRICTIVE FOR ALL TO PUBLIC USING(false) WITH CHECK(false)`);
      const sec16 = await security(f.c);
      assert.equal(deploy(f, 91, 'effective90-final91').status, 0);
      assert.deepEqual((await f.c.query('SELECT * FROM adherence_history_baselines WHERE epoch_id=$1 ORDER BY source_table,row_key', [first])).rows, original);
      assert.equal((await f.c.query('SELECT public.adherence_has_effective_coverage($1) covered', [first])).rows[0].covered, false);
      await f.c.query("INSERT INTO rir_day_targets(client_id,date,training_exercise_id,training_id,target_rir) VALUES ('fixture-client','2026-10-02','te','training',3)");
      assert.equal((await f.c.query("SELECT count(*)::int n FROM adherence_catalog_journal WHERE source_table='rir_day_targets' AND new_row->>'date'='2026-10-02'")).rows[0].n, 1, 'Effective definer captures forced overlay completely');
      const effectiveRows = await images(f.c, [...sources, ...overlays]);
      const third = (await f.c.query('SELECT * FROM public.activate_adherence_history_origin()')).rows[0].id;
      await assertCapture(f.c, effectiveRows, third, true); assert.deepEqual(await security(f.c), sec16);
      const inventory = (await f.c.query('SELECT migration_name,checksum FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name')).rows;
      assert.deepEqual(inventory, names.map(n => ({ migration_name: n, checksum: receipt.migrationHashes[n] })));
      receipt.checks.push({ case: 'upgrade84-91', sources: 13, effective: 16, counts: Object.fromEntries(Object.entries(effectiveRows).map(([k,v]) => [k,v.length])), inventory: 91, original13Preserved: true, securityBefore: sha(JSON.stringify(sec16)), securityAfter: sha(JSON.stringify(await security(f.c))) });
      await sub.test('forced NOBYPASS and row_security=off reject before allocating/writing', async () => {
        await admin.query(`ALTER ROLE ${f.role} NOBYPASSRLS`);
        assert.equal((await f.c.query("SELECT row_security_active('public.diets'::regclass) active")).rows[0].active, true);
        assert.equal((await f.c.query('SELECT count(*)::int n FROM diets')).rows[0].n, 0);
        const epochCount = (await f.c.query('SELECT count(*)::int n FROM adherence_history_epochs')).rows[0].n;
        const sequence = (await f.c.query("SELECT pg_get_serial_sequence('public.adherence_assignment_journal','event_sequence') seq")).rows[0].seq;
        const allocated = (await f.c.query(`SELECT last_value FROM ${sequence}`)).rows[0].last_value;
        for (const setting of ['on','off']) {
          await f.c.query(`SET row_security=${setting}`);
          await assert.rejects(f.c.query('SELECT * FROM public.activate_adherence_history_origin()'), e => e.code === '42501');
          assert.equal((await f.c.query('SELECT count(*)::int n FROM adherence_history_epochs')).rows[0].n, epochCount);
          assert.equal((await f.c.query(`SELECT last_value FROM ${sequence}`)).rows[0].last_value, allocated);
        }
        await admin.query(`ALTER ROLE ${f.role} BYPASSRLS`);
      });
      await sub.test('nonowner BYPASSRLS cannot activate', async () => {
        const other = 'force_other_' + run;
        await admin.query(`CREATE ROLE ${other} LOGIN NOSUPERUSER BYPASSRLS`);
        await admin.query(`GRANT pg_read_all_settings TO ${other}`);
        await f.c.query(`GRANT USAGE ON SCHEMA public TO ${other}; GRANT ALL ON ALL TABLES IN SCHEMA public TO ${other}; GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO ${other}; GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${other}`);
        const u = new URL(f.uri); u.username = other;
        const c = await connect(u.toString(), f.db, other);
        await assert.rejects(c.query('SELECT * FROM public.activate_adherence_history_origin()'), e => e.code === '42501');
      });
    });
    await t.test('baseline85 forced owner without BYPASS rejects and rolls back', async () => {
      const f = await fixture('denied'); await prepare(f);
      await admin.query(`ALTER ROLE ${f.role} NOBYPASSRLS`);
      const seq = (await f.c.query("SELECT pg_get_serial_sequence('public.adherence_assignment_journal','event_sequence') seq")).rows[0].seq;
      const prior = (await f.c.query(`SELECT last_value FROM ${seq}`)).rows[0].last_value;
      await assert.rejects(f.c.query(sql(85)), e => e.code === '42501');
      await f.c.query('ROLLBACK');
      assert.equal((await f.c.query("SELECT to_regclass('public.adherence_history_epochs') e,to_regclass('public.adherence_history_baselines') b")).rows[0].e, null);
      assert.equal((await f.c.query("SELECT to_regclass('public.adherence_history_baselines') b")).rows[0].b, null);
      assert.equal((await f.c.query(`SELECT last_value FROM ${seq}`)).rows[0].last_value, prior);
      receipt.checks.push({ case: 'baseline-NOBYPASS-FORCE-denied', sqlstate: '42501', rollbackObjectsAbsent: true });
    });
    await t.test('normal owner NOFORCE remains compatible', async () => {
      const f = await fixture('normal'), before = await prepare(f, false);
      await admin.query(`ALTER ROLE ${f.role} NOBYPASSRLS`);
      const r = deploy(f, 91, 'normal91'); assert.equal(r.status, 0, r.text);
      const epoch = (await f.c.query('SELECT * FROM public.activate_adherence_history_origin()')).rows[0].id;
      await assertCapture(f.c, before.rows, epoch, true); assert.deepEqual(await security(f.c), before.sec);
      receipt.checks.push({ case: 'normal-NOFORCE-NOBYPASS', completeSources: 16, securityUnchanged: true });
    });
    await t.test('fresh91 installation', async () => {
      const f = await fixture('fresh'); const r = deploy(f, 91, 'fresh91'); assert.equal(r.status, 0, r.text);
      assert.equal((await f.c.query('SELECT count(*)::int n FROM _prisma_migrations WHERE finished_at IS NOT NULL')).rows[0].n, 91);
      receipt.checks.push({ case: 'fresh91', inventory: 91 });
    });
    await t.test('old85 failed Prisma history blocks deploy; owned-only rolled-back recovery', async () => {
      const f = await fixture('recovery'), before = await prepare(f);
      const old = sql(85).replaceAll('pg_catalog.row_security_active(c.oid)', 'c.relforcerowsecurity')
        .replace('    -- FORCE RLS is compatible only when this effective role sees all rows.\n', '');
      assert.equal(sha(old), 'bb1f7559958e86635ffe6d7facdd6411528cb537dce25007cfd7a2d5f9b87540', 'Exact pre-fix85 bytes, not an invented legacy guard');
      await assert.rejects(f.c.query(old), e => e.code === '42501' && /History capture requires/.test(e.message));
      await f.c.query('ROLLBACK');
      const failed = deploy(f, 85, 'old85-failure', old);
      assert.notEqual(failed.status, 0); assert.match(failed.text, /current transaction is aborted|42501/);
      assert.equal((await f.c.query("SELECT to_regclass('public.adherence_history_epochs') e")).rows[0].e, null);
      assert.deepEqual(await images(f.c, [...sources, ...overlays]), before.rows);
      assert.deepEqual(await security(f.c), before.sec);
      const blocked = deploy(f, 91, 'p3009'); assert.notEqual(blocked.status, 0); assert.match(blocked.text, /P3009/);
      assert.equal(deploy(f, 91, 'owned-rolled-back', undefined, ['migrate','resolve','--rolled-back',names[84]]).status, 0);
      const recovered = deploy(f, 91, 'recovered91'); assert.equal(recovered.status, 0, recovered.text);
      assert.deepEqual(await security(f.c), before.sec);
      receipt.checks.push({ case: 'local-only-failed85-recovery', sqlstate: '42501', blocked: 'P3009', rollbackObjectsAbsent: true, inventory: (await f.c.query('SELECT count(*)::int n FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')).rows[0].n, old85Sha256: sha(old) });
    });
  } finally {
    await Promise.all(clients.map(c => c.end()));
    fs.writeFileSync(path.join(dir, 'receipt.json'), JSON.stringify(receipt, null, 2));
    console.log('Safe local receipt: ' + path.join(dir, 'receipt.json'));
  }
});
