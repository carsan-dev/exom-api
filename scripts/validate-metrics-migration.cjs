const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Pool } = require('pg');
const { databaseUrl, assertTestDatabase } = require('./test-database.cjs');

async function main() {
  const url = databaseUrl();
  const pool = new Pool({ connectionString: url });
  const root = path.resolve(__dirname, '..');
  const stage = path.join(root, '.local', 'metrics-migration');
  const migration = '20260916120000_recap_optional_habits';
  const cli = path.join(root, 'node_modules/prisma/build/index.js');
  function migrate(target, config) {
    const child = spawnSync(process.execPath, [cli, 'migrate', 'deploy', ...(config ? ['--config', config] : [])], {
      cwd: root, stdio: 'inherit', windowsHide: true,
      env: { ...process.env, DATABASE_URL: target, PRISMA_DATABASE_URL: target },
    });
    assert.equal(child.status, 0, 'migrate deploy');
  }
  try {
    await assertTestDatabase(pool);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public'")).rows[0].n, 0, 'requires fresh disposable database');
    fs.mkdirSync(path.join(stage, 'migrations'), { recursive: true });
    for (const entry of fs.readdirSync(path.join(root, 'prisma/migrations'))) {
      if (entry !== migration) fs.cpSync(path.join(root, 'prisma/migrations', entry), path.join(stage, 'migrations', entry), { recursive: true });
    }
    const config = path.join(stage, 'prisma.config.ts');
    fs.writeFileSync(config, `import { defineConfig } from 'prisma/config';\nexport default defineConfig({schema:'../../prisma/schema.prisma', migrations:{path:'./migrations'}, datasource:{url:process.env.PRISMA_DATABASE_URL}});\n`);
    migrate(url, config);
    await pool.query(`INSERT INTO users(id,email,firebase_uid,updated_at) VALUES('p1-legacy','p1-legacy@example.test','p1-legacy',now());
      INSERT INTO weekly_recaps(id,client_id,week_start_date,week_end_date,stress_enabled,stress_level,status,improvement_areas,updated_at)
      VALUES('p1-legacy','p1-legacy','2026-09-07','2026-09-13',true,0,'SUBMITTED','{}',now());
      INSERT INTO body_metrics(id,client_id,date,weight_kg,sleep_hours) VALUES('p1-legacy','p1-legacy','2026-09-07',75,0);
      INSERT INTO day_progress(id,client_id,date,meals_completed,notes,updated_at) VALUES('p1-legacy','p1-legacy','2026-09-07','{}','Conservar nota histórica',now());`);
    const legacy = (await pool.query('SELECT to_jsonb(r) AS row FROM weekly_recaps r WHERE id=$1', ['p1-legacy'])).rows[0].row;
    migrate(url);
    const upgraded = (await pool.query('SELECT to_jsonb(r) AS row FROM weekly_recaps r WHERE id=$1', ['p1-legacy'])).rows[0].row;
    assert.deepEqual(upgraded, { ...legacy, hunger_level: null, energy_level: null, digestion_level: null });
    assert.equal((await pool.query("SELECT notes FROM day_progress WHERE id='p1-legacy'")).rows[0].notes, 'Conservar nota histórica');
    assert.equal((await pool.query("SELECT sleep_hours FROM body_metrics WHERE id='p1-legacy'")).rows[0].sleep_hours, 0);
    for (const field of ['hunger_level','energy_level','digestion_level']) {
      for (const value of [0,11]) await assert.rejects(pool.query(`UPDATE weekly_recaps SET ${field}=$1 WHERE id='p1-legacy'`, [value]), { code: '23514' });
      for (const value of [1,10,null]) await pool.query(`UPDATE weekly_recaps SET ${field}=$1 WHERE id='p1-legacy'`, [value]);
    }
    console.log('PASS legacy upgrade: all original recap fields, stress zero, body metrics and notes preserved; NULL defaults and DB bounds verified');
    await pool.query('CREATE DATABASE exom_ci_metrics_fresh');
    const freshUrl = new URL(url); freshUrl.pathname = '/exom_ci_metrics_fresh';
    const fresh = new Pool({ connectionString: freshUrl.toString() });
    try {
      const identity = (await fresh.query("SELECT current_user AS role,current_setting('data_directory') AS directory")).rows[0];
      assert.equal(identity.role, 'exom_ci');
      assert.equal(identity.directory, '/var/lib/postgresql/exom-ci-data');
      migrate(freshUrl.toString());
      assert.equal((await fresh.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='weekly_recaps' AND column_name IN ('hunger_level','energy_level','digestion_level')")).rows[0].n, 3);
      console.log('PASS fresh installation: complete migration chain');
    } finally { await fresh.end(); }
  } finally { await pool.end(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
