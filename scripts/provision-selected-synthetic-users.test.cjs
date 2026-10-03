'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { provision, validateInput, validateContainer, validateFirebase, pgAdapter, readInput } = require('./provision-selected-synthetic-users.cjs');
const input = { clientPassword: 'dummy-six', superadminPassword: 'dummy-eleven' };
function container() {
  return { Name: '/exom-p4-t1-ci-20260928', Config: { Image: 'postgres:17', Labels: { 'exom.scope': 'p4-t1-20260928' }, Env: ['PGDATA=/var/lib/postgresql/exom-ci-data', 'POSTGRES_USER=exom_ci', 'POSTGRES_DB=exom_ci', 'POSTGRES_PASSWORD=dummy-db'] }, State: { Running: true }, NetworkSettings: { Ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '55493' }] } }, Mounts: [{ Type: 'volume', Name: 'exom-p4-t1-ci-20260928-data', Destination: '/var/lib/postgresql/exom-ci-data' }] };
}
function fixture() {
  const rows = new Map(), accounts = new Map(), mutations = [], manifests = [];
  let serial = 0;
  const db = {
    async lookup(email) { return rows.has(email) ? [rows.get(email)] : []; },
    async uidOwned(uid, email) { return [...rows.values()].some(r => r.firebase_uid === uid && r.email !== email); },
    async transaction(fn) { const backup = structuredClone(rows); try { await fn(db); } catch (e) { rows.clear(); for (const [k, v] of backup) rows.set(k, v); throw e; } },
    async lock(email) { mutations.push(['lock', email]); },
    async insert(target, uid) { rows.set(target.email, { id: `id-${++serial}`, email: target.email, firebase_uid: uid, role: target.role, is_active: true, profile: false }); },
    async ensureProfile(target) { rows.get(target.email).profile ||= target.name; },
    async hasProfile(email) { return Boolean(rows.get(email)?.profile); }
  };
  const auth = {
    async getUserByEmail(email) { if (!accounts.has(email)) throw Object.assign(Error('private body'), { code: 'auth/user-not-found' }); return accounts.get(email); },
    async createUser(data) { mutations.push(['create', data.email]); assert.deepEqual(Object.keys(data).sort(), ['email', 'password']); const account = { uid: `uid-${data.email}`, email: data.email, disabled: false, emailVerified: false }; accounts.set(data.email, account); return account; },
    async updateUser(uid, data) { mutations.push(['update', uid]); assert.deepEqual(Object.keys(data), ['password']); }
  };
  return { rows, accounts, mutations, manifests, db, auth, config: { projectId: 'exom-dev', validated: true }, status: async s => manifests.push(structuredClone(s)) };
}
test('input rejects extra keys, malformed values, and short passwords; six is accepted', () => {
  validateInput({ clientPassword: '123456', superadminPassword: '123456' });
  for (const bad of [null, [], { ...input, email: 'other' }, { ...input, clientPassword: 'short' }, { ...input, superadminPassword: 42 }]) assert.throws(() => validateInput(bad));
});
test('container and Firebase guards refuse every changed boundary', () => {
  assert.match(validateContainer(container()), /^postgresql:/);
  const withImageVolume = container(); withImageVolume.Mounts.push({ Type: 'volume', Name: 'anonymous', Destination: '/var/lib/postgresql/data' });
  assert.match(validateContainer(withImageVolume), /^postgresql:/);
  for (const change of [c => c.Name += '-other', c => c.Config.Image = 'postgres:18', c => c.Config.Labels['exom.scope'] = 'other', c => c.State.Running = false, c => c.NetworkSettings.Ports['5432/tcp'][0].HostIp = '0.0.0.0', c => c.NetworkSettings.Ports['5432/tcp'][0].HostPort = '55494', c => c.Mounts[0].Name = 'other', c => c.Config.Env.push('POSTGRES_PASSWORD_FILE=/secret'), c => c.Config.Env[0] = 'PGDATA=/other', c => c.Mounts.push({ Type: 'bind', Destination: '/other' })]) { const c = container(); change(c); assert.throws(() => validateContainer(c)); }
  const cert = { projectId: 'exom-dev', clientEmail: 'synthetic@exom-dev.iam.gserviceaccount.com', privateKey: 'dummy-cert' }; validateFirebase(cert, {});
  for (const [c, env] of [[{ ...cert, projectId: 'exom-prod' }, {}], [cert, { FIREBASE_AUTH_EMULATOR_HOST: 'localhost' }], [{ ...cert, clientEmail: 'other@exom-prod.iam.gserviceaccount.com' }, {}], [{ ...cert, privateKey: '' }, {}]]) assert.throws(() => validateFirebase(c, env));
});
test('preflights both targets before mutations on role/state/identity failures', async () => {
  for (const patch of [{ role: 'ADMIN' }, { is_locked: true }, { is_active: false }, { identity_pending: true }, { is_archived: true }, { locked_at: new Date() }, { firebase_uid: 'mismatch' }, { email: 'SUPERADMIN@exom.dev' }]) {
    const f = fixture(); f.accounts.set('superadmin@exom.dev', { email: 'superadmin@exom.dev', uid: 'expected' });
    f.rows.set('superadmin@exom.dev', { email: 'superadmin@exom.dev', firebase_uid: 'expected', role: 'SUPER_ADMIN', is_active: true, ...patch });
    await assert.rejects(provision(input, f)); assert.equal(f.mutations.length, 0);
  }
  for (const patch of [{ disabled: true }, { email: 'SUPERADMIN@exom.dev' }]) {
    const f = fixture(); f.accounts.set('superadmin@exom.dev', { uid: 'expected', email: 'superadmin@exom.dev', ...patch });
    await assert.rejects(provision(input, f)); assert.equal(f.mutations.length, 0);
  }
});
test('UID collision and case-insensitive duplicates fail before Firebase writes', async () => {
  const f = fixture(); f.accounts.set('cliente@exom.dev', { email: 'cliente@exom.dev', uid: 'owned' }); f.rows.set('other', { email: 'other', firebase_uid: 'owned' });
  await assert.rejects(provision(input, f)); assert.equal(f.mutations.length, 0);
  const g = fixture(); g.db.lookup = async () => [{}, {}]; await assert.rejects(provision(input, g)); assert.equal(g.mutations.length, 0);
});
test('two correct roles/profiles; rerun preserves IDs and existing profiles', async () => {
  const f = fixture(); await provision(input, f);
  assert.equal(f.rows.get('cliente@exom.dev').role, 'CLIENT'); assert.equal(f.rows.get('superadmin@exom.dev').role, 'SUPER_ADMIN');
  assert.equal(f.rows.get('cliente@exom.dev').profile, 'Synthetic Client'); assert.equal(f.rows.get('superadmin@exom.dev').profile, 'Synthetic Superadmin');
  const ids = [...f.rows.values()].map(r => r.id); f.rows.get('cliente@exom.dev').profile = 'Preserved'; f.accounts.get('cliente@exom.dev').emailVerified = true;
  await provision(input, f); assert.deepEqual([...f.rows.values()].map(r => r.id), ids); assert.equal(f.rows.get('cliente@exom.dev').profile, 'Preserved'); assert.equal(f.accounts.get('cliente@exom.dev').emailVerified, true);
  assert.deepEqual(f.mutations.filter(m => m[0] === 'lock').slice(0, 2).map(m => m[1]), ['cliente@exom.dev', 'superadmin@exom.dev']);
  const output = JSON.stringify(f.manifests); for (const secret of [...Object.values(input), ...[...f.accounts.values()].map(a => a.uid)]) assert.ok(!output.includes(secret));
});
test('Firebase survives DB rollback; manifest exposes only recoverable code', async () => {
  const f = fixture(); f.db.insert = async () => { throw Object.assign(Error(input.clientPassword), { code: '23505' }); };
  await assert.rejects(provision(input, f), e => e.code === '23505'); assert.equal(f.accounts.size, 2); assert.equal(f.rows.size, 0);
  const last = f.manifests.at(-1); assert.equal(last.phase, 'recoverable'); assert.equal(last.errorCode, '23505'); assert.ok(!JSON.stringify(last).includes(input.clientPassword));
});
test('create race relooks up only exact email; rechecks DB before inserts', async () => {
  const f = fixture(); const create = f.auth.createUser; f.auth.createUser = async data => { await create(data); throw Object.assign(Error(), { code: 'auth/email-already-exists' }); };
  await provision(input, f); assert.equal(f.rows.size, 2);
  const g = fixture(); g.db.lock = async () => { g.rows.set('superadmin@exom.dev', { email: 'superadmin@exom.dev', role: 'ADMIN', is_active: true }); };
  await assert.rejects(provision(input, g)); assert.equal(g.rows.size, 0); assert.equal(g.accounts.size, 2);
});
test('unsafe config, failed status intent and SDK body never cause secret logging', async () => {
  for (const config of [{ projectId: 'exom-prod', validated: true }, { projectId: 'exom-dev', validated: false }]) { const f = fixture(); f.config = config; await assert.rejects(provision(input, f)); assert.equal(f.mutations.length, 0); }
  const f = fixture(); f.status = async () => { throw Error(input.clientPassword); }; await assert.rejects(provision(input, f), e => e.message === 'OPERATION_FAILED'); assert.equal(f.mutations.length, 0);
  const g = fixture(); g.auth.createUser = async () => { throw Object.assign(Error(input.clientPassword), { code: input.superadminPassword }); };
  await assert.rejects(provision(input, g), e => e.message === 'OPERATION_FAILED'); assert.ok(!JSON.stringify(g.manifests).includes(input.superadminPassword));
});
test('STDIN JSON handles quotes/newlines/unicode and zeroes original byte buffers', async () => {
  const payload = { clientPassword: 'dummy\n"\\é𐀀', superadminPassword: input.superadminPassword };
  const buffer = Buffer.from(JSON.stringify(payload)); const result = await readInput(require('node:stream').Readable.from([buffer]));
  assert.deepEqual(result, payload); assert.ok(buffer.every(byte => byte === 0));
  await assert.rejects(readInput(require('node:stream').Readable.from([Buffer.from('{bad')])));
});
test('post-commit readback failure durably records both accounts committed_unverified without secrets', async () => {
  const f = fixture(); const transaction = f.db.transaction;
  f.db.transaction = async fn => {
    await transaction(fn);
    f.auth.getUserByEmail = async () => {
      assert.deepEqual(f.manifests.at(-1).accounts.map(a => a.database), ['committed_unverified', 'committed_unverified']);
      throw Error(`private body ${input.clientPassword} ${f.accounts.get('cliente@exom.dev').uid}`);
    };
  };
  await assert.rejects(provision(input, f), e => e.code === 'OPERATION_FAILED');
  assert.equal(f.rows.size, 2);
  const last = f.manifests.at(-1); assert.equal(last.phase, 'recoverable');
  assert.deepEqual(last.accounts.map(a => a.database), ['committed_unverified', 'committed_unverified']);
  const output = JSON.stringify(f.manifests);
  for (const secret of ['private body', ...Object.values(input), ...[...f.accounts.values()].map(a => a.uid)]) assert.ok(!output.includes(secret));
});
test('unknown COMMIT acknowledgement preserves durable write_pending for both targets', async () => {
  const f = fixture(); const transaction = f.db.transaction;
  f.db.transaction = async fn => {
    assert.deepEqual(f.manifests.at(-1).accounts.map(a => a.database), ['write_pending', 'write_pending']);
    await transaction(fn); throw Error('acknowledgement lost');
  };
  await assert.rejects(provision(input, f), e => e.code === 'OPERATION_FAILED');
  assert.equal(f.rows.size, 2);
  assert.deepEqual(f.manifests.at(-1).accounts.map(a => a.database), ['write_pending', 'write_pending']);
});
test('Windows wrapper selects one node.exe before Source and validates the resulting string', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, 'provision-selected-synthetic-users.ps1'), 'utf8');
  assert.match(source, /Get-Command node\.exe -CommandType Application -ErrorAction Stop \| Select-Object -First 1\)\.Source/);
  assert.match(source, /\$node -isnot \[string\]/);
  assert.match(source, /\[string\]::IsNullOrWhiteSpace\(\$node\)/);
});
test('SQL adapter has bound inputs, manual updated_at, profiles preserved and rollback', async () => {
  const queries = []; let released = false;
  const client = { async query(sql, params) { queries.push({ sql, params }); return { rows: [] }; }, release() { released = true; } };
  const db = pgAdapter({ ...client, async connect() { return client; } });
  await assert.rejects(db.transaction(async tx => { await tx.lock('cliente@exom.dev'); await tx.lookup('cliente@exom.dev'); await tx.insert({ email: 'cliente@exom.dev', role: 'CLIENT' }, 'dummy-uid'); await tx.ensureProfile({ email: 'cliente@exom.dev', name: 'Synthetic Client' }); throw Error('failure'); }));
  assert.equal(queries[0].sql, 'BEGIN'); assert.equal(queries.at(-1).sql, 'ROLLBACK'); assert.ok(released);
  assert.ok(queries.some(q => q.sql.includes('pg_advisory_xact_lock')));
  assert.ok(queries.some(q => q.sql.includes('FOR UPDATE')));
  for (const q of queries.filter(q => q.sql.includes('INSERT'))) { assert.ok(q.sql.includes('updated_at')); assert.ok(!q.sql.includes('cliente@exom.dev')); }
  assert.ok(queries.some(q => q.sql.includes('ON CONFLICT(user_id) DO NOTHING')));
});
