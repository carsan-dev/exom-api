'use strict';
// Operator-only CLI. Importing this module never loads SDKs, configuration or credentials.
const TARGETS = Object.freeze([
  Object.freeze({ email: 'cliente@exom.dev', role: 'CLIENT', name: 'Synthetic Client', passwordKey: 'clientPassword' }),
  Object.freeze({ email: 'superadmin@exom.dev', role: 'SUPER_ADMIN', name: 'Synthetic Superadmin', passwordKey: 'superadminPassword' })
]);
function fail(code) { throw Object.assign(new Error(code), { code }); }
const SAFE_CODES = new Set(['INVALID_INPUT', 'UNSAFE_CONTAINER', 'UNSAFE_FIREBASE', 'UNSAFE_CONFIG', 'IDENTITY_CONFLICT', 'ACCOUNT_UNAVAILABLE', 'READBACK_FAILED', '23505', '40001', '40P01', 'auth/invalid-password', 'auth/password-does-not-meet-requirements', 'auth/insufficient-permission', 'auth/invalid-credential', 'auth/email-already-exists', 'auth/user-not-found', 'auth/user-disabled', 'auth/too-many-requests']);
function errorCode(error) { return SAFE_CODES.has(error?.code) ? error.code : 'OPERATION_FAILED'; }
function validateInput(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object' ||
      Object.keys(value).sort().join(',') !== 'clientPassword,superadminPassword' ||
      TARGETS.some(t => typeof value[t.passwordKey] !== 'string' || value[t.passwordKey].length < 6)) fail('INVALID_INPUT');
  return value;
}
function validateContainer(c) {
  const env = Object.fromEntries((c?.Config?.Env || []).map(entry => { const i = entry.indexOf('='); return [entry.slice(0, i), entry.slice(i + 1)]; }));
  const ports = c?.NetworkSettings?.Ports;
  const bindings = ports?.['5432/tcp'];
  const mounts = c?.Mounts || [];
  if (c?.Name !== '/exom-p4-t1-ci-20260928' || c?.Config?.Image !== 'postgres:17' ||
      c?.Config?.Labels?.['exom.scope'] !== 'p4-t1-20260928' || c?.State?.Running !== true ||
      env.PGDATA !== '/var/lib/postgresql/exom-ci-data' || env.POSTGRES_USER !== 'exom_ci' || env.POSTGRES_DB !== 'exom_ci' ||
      !env.POSTGRES_PASSWORD || Object.keys(env).some(k => k.endsWith('_FILE')) ||
      !bindings || bindings.length !== 1 || bindings[0].HostIp !== '127.0.0.1' || bindings[0].HostPort !== '55493' ||
      Object.entries(ports).some(([key, value]) => key !== '5432/tcp' && value !== null) ||
      mounts.filter(m => m.Type === 'volume' && m.Name === 'exom-p4-t1-ci-20260928-data' && m.Destination === env.PGDATA).length !== 1 ||
      mounts.some(m => m.Type !== 'volume' || ![env.PGDATA, '/var/lib/postgresql/data'].includes(m.Destination)) ||
      mounts.filter(m => m.Destination === '/var/lib/postgresql/data').length > 1) fail('UNSAFE_CONTAINER');
  return `postgresql://exom_ci:${encodeURIComponent(env.POSTGRES_PASSWORD)}@127.0.0.1:55493/exom_ci`;
}
function validateFirebase(cert, env) {
  if (Object.hasOwn(env, 'FIREBASE_AUTH_EMULATOR_HOST') || cert.projectId !== 'exom-dev' ||
      typeof cert.clientEmail !== 'string' || !cert.clientEmail.endsWith('@exom-dev.iam.gserviceaccount.com') || !cert.privateKey) fail('UNSAFE_FIREBASE');
}
function checkFirebase(account, target) {
  if (!account || account.email !== target.email || !account.uid) fail('IDENTITY_CONFLICT');
  if (account.disabled) fail('ACCOUNT_UNAVAILABLE');
}
async function lookupAuth(auth, target) {
  try { const account = await auth.getUserByEmail(target.email); checkFirebase(account, target); return account; }
  catch (e) { if (e.code === 'auth/user-not-found') return null; throw e; }
}
async function checkDb(db, target, account) {
  const rows = await db.lookup(target.email);
  if (rows.length > 1) fail('IDENTITY_CONFLICT');
  const row = rows[0];
  if (row) {
    if (row.email !== target.email || row.role !== target.role || !account || row.firebase_uid !== account.uid) fail('IDENTITY_CONFLICT');
    if (row.is_active !== true || row.is_locked || row.is_archived || row.identity_pending || row.locked_at) fail('ACCOUNT_UNAVAILABLE');
  }
  if (account && await db.uidOwned(account.uid, target.email)) fail('IDENTITY_CONFLICT');
  return row;
}
async function provision(input, { auth, db, config, status }) {
  validateInput(input);
  if (config?.projectId !== 'exom-dev' || config?.validated !== true) fail('UNSAFE_CONFIG');
  const report = { project: 'exom-dev', phase: 'preflight', accounts: TARGETS.map(t => ({ email: t.email, targetRole: t.role, firebase: 'unchecked', database: 'unchecked' })) };
  const accounts = [];
  try {
    for (const [i, target] of TARGETS.entries()) {
      const account = await lookupAuth(auth, target);
      const row = await checkDb(db, target, account);
      accounts.push(account);
      report.accounts[i].firebase = account ? 'exists' : 'missing';
      report.accounts[i].database = row ? 'exists' : 'missing';
    }
    // A durable, secret-free intent precedes every external mutation. If recording fails, stop.
    for (const [i, target] of TARGETS.entries()) {
      report.phase = 'firebase'; report.accounts[i].firebase = 'mutation_pending'; await status(report);
      let account = accounts[i];
      if (!account) {
        try { account = await auth.createUser({ email: target.email, password: input[target.passwordKey] }); }
        catch (e) {
          if (e.code !== 'auth/email-already-exists') throw e;
          account = await lookupAuth(auth, target); checkFirebase(account, target);
          await checkDb(db, target, account);
          await auth.updateUser(account.uid, { password: input[target.passwordKey] });
        }
      } else {
        // Recheck disabled/identity immediately before password update; never reset flags.
        const current = await lookupAuth(auth, target); checkFirebase(current, target);
        if (current.uid !== account.uid) fail('IDENTITY_CONFLICT');
        await auth.updateUser(account.uid, { password: input[target.passwordKey] });
      }
      checkFirebase(account, target); accounts[i] = account;
      report.accounts[i].firebase = 'ready'; await status(report);
    }
    report.phase = 'database';
    for (const account of report.accounts) account.database = 'write_pending';
    await status(report);
    await db.transaction(async tx => {
      for (const target of [...TARGETS].sort((a, b) => a.email.localeCompare(b.email))) await tx.lock(target.email);
      // Recheck both before inserting either; unique constraints still arbitrate non-cooperating writers.
      const existing = [];
      for (const [i, target] of TARGETS.entries()) existing.push(await checkDb(tx, target, accounts[i]));
      for (const [i, target] of TARGETS.entries()) {
        if (!existing[i]) await tx.insert(target, accounts[i].uid);
        await tx.ensureProfile(target);
      }
    });
    for (const account of report.accounts) account.database = 'committed_unverified';
    await status(report);
    for (const [i, target] of TARGETS.entries()) {
      const account = await lookupAuth(auth, target);
      if (account?.uid !== accounts[i].uid || !await checkDb(db, target, account) || !await db.hasProfile(target.email)) fail('READBACK_FAILED');
      report.accounts[i].database = 'verified';
    }
    report.phase = 'complete'; await status(report); return report;
  } catch (error) {
    report.phase = 'recoverable'; report.errorCode = errorCode(error);
    try { await status(report); } catch { /* Earlier durable intent remains the recovery record. */ }
    // Never delete Firebase users as compensation. A subsequent explicit run inspects by email.
    fail(report.errorCode);
  }
}
function pgAdapter(pool) {
  const { randomUUID } = require('node:crypto');
  function adapter(client, locking = false) {
    return {
      async lookup(email) { return (await client.query('SELECT id,email,firebase_uid,role,is_active,is_locked,is_archived,identity_pending,locked_at FROM users WHERE lower(email)=lower($1)' + (locking ? ' FOR UPDATE' : ''), [email])).rows; },
      async uidOwned(uid, email) { return (await client.query('SELECT EXISTS(SELECT 1 FROM users WHERE firebase_uid=$1 AND email<>$2) AS owned', [uid, email])).rows[0].owned; },
      async lock(email) { await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`exom-p4-provision:${email}`]); },
      async insert(target, uid) { await client.query(`INSERT INTO users(id,email,firebase_uid,role,auth_provider,updated_at) VALUES($1,$2,$3,$4::"Role",'email',now())`, [randomUUID(), target.email, uid, target.role]); },
      async ensureProfile(target) {
        const [first, ...last] = target.name.split(' ');
        await client.query(`INSERT INTO profiles(id,user_id,first_name,last_name,updated_at)
          SELECT $1,id,$2,$3,now() FROM users WHERE email=$4
          ON CONFLICT(user_id) DO NOTHING`, [randomUUID(), first, last.join(' '), target.email]);
      },
      async hasProfile(email) { return (await client.query('SELECT EXISTS(SELECT 1 FROM profiles p JOIN users u ON u.id=p.user_id WHERE u.email=$1) AS present', [email])).rows[0].present; }
    };
  }
  return { ...adapter(pool), async transaction(fn) {
    const client = await pool.connect();
    try { await client.query('BEGIN'); await fn(adapter(client, true)); await client.query('COMMIT'); }
    catch (e) { try { await client.query('ROLLBACK'); } catch { /* No compensation outside this DB transaction. */ } throw e; }
    finally { client.release(); }
  } };
}
async function readInput(stream) {
  const chunks = []; let size = 0;
  try {
    for await (const chunk of stream) { chunks.push(chunk); size += chunk.length; if (size > 32768) fail('INVALID_INPUT'); }
    const bytes = Buffer.concat(chunks);
    try { return validateInput(JSON.parse(bytes.toString('utf8'))); }
    catch { fail('INVALID_INPUT'); }
    finally { bytes.fill(0); }
  } finally { for (const chunk of chunks) chunk.fill(0); }
}
async function main() {
  const fs = require('node:fs'); const path = require('node:path');
  const { execFileSync } = require('node:child_process');
  let pool, app, input;
  try {
    if (process.argv.length !== 2) fail('INVALID_INPUT');
    input = await readInput(process.stdin);
    if (Object.hasOwn(process.env, 'FIREBASE_AUTH_EMULATOR_HOST')) fail('UNSAFE_FIREBASE');
    const capture = execFileSync('docker', ['inspect', 'exom-p4-t1-ci-20260928'], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024 });
    let url;
    try { const containers = JSON.parse(capture.toString('utf8')); if (containers.length !== 1) fail('UNSAFE_CONTAINER'); url = validateContainer(containers[0]); }
    finally { capture.fill(0); }
    // These aliases belong only to this child process, never the operator or running API.
    for (const key of ['TEST_DATABASE_URL', 'DATABASE_URL', 'DIRECT_URL', 'PRISMA_DATABASE_URL']) process.env[key] = url;
    const envBytes = fs.readFileSync(path.join(__dirname, '..', '.env'));
    let cert;
    try {
      const env = require('dotenv').parse(envBytes);
      cert = { projectId: env.FIREBASE_PROJECT_ID, clientEmail: env.FIREBASE_CLIENT_EMAIL,
        privateKey: env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'), privateKeyId: env.FIREBASE_PRIVATE_KEY_ID };
      validateFirebase(cert, { ...process.env, ...(Object.hasOwn(env, 'FIREBASE_AUTH_EMULATOR_HOST') ? { FIREBASE_AUTH_EMULATOR_HOST: env.FIREBASE_AUTH_EMULATOR_HOST } : {}) });
    } finally { envBytes.fill(0); }
    pool = new (require('pg').Pool)({ connectionString: url, connectionTimeoutMillis: 3000 });
    await require('./test-database.cjs').assertTestDatabase(pool);
    const admin = require('firebase-admin');
    app = admin.initializeApp({ credential: admin.credential.cert(cert), projectId: 'exom-dev' }, `p4-provision-${require('node:crypto').randomUUID()}`);
    const directory = path.join(require('node:os').tmpdir(), `exom-p4-provision-${require('node:crypto').randomUUID()}`);
    fs.mkdirSync(directory, { mode: 0o700 });
    const manifest = path.join(directory, 'status.json');
    const status = async report => {
      // Atomic replacement prevents partial JSON after a crash; only this freshly owned directory is touched.
      const pending = path.join(directory, 'status.pending');
      fs.writeFileSync(pending, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(pending, manifest);
    };
    console.log(`Status manifest: ${manifest}`);
    const result = await provision(input, { auth: app.auth(), db: pgAdapter(pool), config: { projectId: 'exom-dev', validated: true }, status });
    for (const account of result.accounts) console.log(`${account.email} ${account.targetRole} ${account.database}`);
  } finally {
    if (input) { input.clientPassword = ''; input.superadminPassword = ''; }
    if (pool) await pool.end(); if (app) await app.delete();
    for (const key of ['TEST_DATABASE_URL', 'DATABASE_URL', 'DIRECT_URL', 'PRISMA_DATABASE_URL']) delete process.env[key];
  }
}
module.exports = { provision, validateInput, validateContainer, validateFirebase, pgAdapter, readInput };
if (require.main === module) main().catch(error => { console.error(errorCode(error)); process.exitCode = 1; });
