const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { payloadHash, endpointMap } = require('./benchmark-dashboard.cjs');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireHash(value, locator) {
  assert.ok(typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value), 'Required SHA256 provenance: ' + locator);
}

function compare(before, after, windows) {
  const allowed = new Set(['profile.data.profile.id', 'day.data.diet_history.0.captured_at']);
  for (let index = 0; index < 200; index++) allowed.add(`selector.data.data.${index}.profile.id`);
  for (const [index, responses] of [before, after].entries()) {
    const rows = responses.selector.data.data;
    assert.equal(rows.length, 200);
    const owners = new Set(), profiles = new Set();
    for (const row of rows) {
      assert.match(row.id, UUID);
      assert.match(row.profile.id, UUID);
      assert.equal(row.profile.user_id, row.id);
      assert.ok(!owners.has(row.id) && !profiles.has(row.profile.id), 'Profile identity alias');
      owners.add(row.id); profiles.add(row.profile.id);
    }
    const profile = responses.profile.data;
    const owner = rows.find((row) => row.id === profile.id);
    assert.ok(owner, 'Primary client absent');
    assert.equal(profile.profile.user_id, profile.id);
    assert.equal(profile.profile.id, owner.profile.id);
    const history = responses.day.data.diet_history;
    assert.equal(history.length, 1);
    assert.equal(history[0].client_id, profile.id);
    const timestamp = history[0].captured_at;
    assert.match(timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const instant = Date.parse(timestamp);
    assert.ok(Number.isFinite(instant));
    assert.equal(new Date(instant).toISOString(), timestamp);
    const [start, end] = windows[index];
    assert.ok(Number.isFinite(start) && Number.isFinite(end) && start <= instant && instant <= end, 'Capture outside owned measurement window');
  }
  const originalOwners = new Map(before.selector.data.data.map((row) => [row.profile.id, row.id]));
  for (const row of after.selector.data.data) {
    if (originalOwners.has(row.profile.id)) assert.equal(originalOwners.get(row.profile.id), row.id, 'Cross-run profile identity alias');
  }
  const differences = [];
  function walk(left, right, locator) {
    if (Object.is(left, right)) return;
    if (left && right && typeof left === 'object' && typeof right === 'object') {
      assert.equal(Array.isArray(left), Array.isArray(right), locator);
      assert.deepEqual(Object.keys(left).sort(), Object.keys(right).sort(), locator + ' shape');
      for (const key of Object.keys(left)) walk(left[key], right[key], locator ? `${locator}.${key}` : key);
    } else {
      assert.ok(allowed.has(locator), 'Unapproved difference: ' + locator);
      differences.push({ path: locator, before: left, after: right });
    }
  }
  walk(before, after, '');
  assert.equal(differences.length, 202, 'Exact historical volatile difference set');
  assert.deepEqual(new Set(differences.map((item) => item.path)), allowed);
  const mapped = structuredClone(after);
  for (const item of differences) {
    const keys = item.path.split('.');
    const leaf = keys.pop();
    let target = mapped;
    for (const key of keys) target = target[key];
    target[leaf] = item.before;
  }
  assert.deepEqual(mapped, before);
  const endpoints = Object.fromEntries(endpointMap('client', '2026-10-11').map(([name]) => {
    const rawEqual = payloadHash(before[name]) === payloadHash(after[name]);
    assert.equal(rawEqual, !['selector', 'profile', 'day'].includes(name));
    return [name, { raw_equal: rawEqual, canonical_hash: payloadHash(mapped[name]) }];
  }));
  return { differences, endpoints, canonical_equal: true, raw_equal: false };
}

if (require.main === module) {
  const [beforeDirectory, afterDirectory] = process.argv.slice(2);
  const load = (directory, file) => JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'));
  const before = load(beforeDirectory, 'measurement.json'), after = load(afterDirectory, 'measurement.json');
  requireHash(before.fixture_hash, 'before.fixture_hash');
  requireHash(after.fixture_hash, 'after.fixture_hash');
  assert.equal(before.fixture_hash, after.fixture_hash);
  const windows = [beforeDirectory, afterDirectory].map((directory) => [
    fs.statSync(path.join(directory, 'resource.json')).birthtimeMs,
    fs.statSync(path.join(directory, 'measurement.json')).mtimeMs,
  ]);
  const originalManifest = load(beforeDirectory, 'manifest.json'), candidateManifest = load(afterDirectory, 'manifest.json');
  for (const file of ['docs/evidence/dashboard-performance-20261011/benchmark-dashboard.cjs', 'docs/evidence/dashboard-performance-20261011/test.cjs', 'scripts/run-recap-review-persistence.cjs']) {
    requireHash(originalManifest.before?.[file], 'before manifest: ' + file);
    requireHash(candidateManifest.before?.[file], 'after manifest: ' + file);
    assert.equal(originalManifest.before[file], candidateManifest.before[file], 'Measured harness drift: ' + file);
  }
  const result = compare(before.responses, after.responses, windows);
  result.window_provenance = 'Retained local resource.json creation time through measurement.json modification time; same-host local PG clock, no private paths published';
  result.capture_windows_utc = windows.map((window) => window.map((value) => new Date(value).toISOString()));
  result.fixture_descriptor_hash = before.fixture_hash;
  result.days = before.fixture.days;
  result.samples = Object.fromEntries(Object.keys(result.endpoints).map((name) => {
    const left = before.endpoints[name], right = after.endpoints[name];
    assert.equal(left.warm.bytes.median, right.warm.bytes.median, name + ' byte drift');
    assert.equal(payloadHash(before.responses[name]), left.warm.hash);
    assert.equal(payloadHash(after.responses[name]), right.warm.hash);
    return [name, { before: left.warm, after: right.warm, first_before: left.first_request.wall_ms, first_after: right.first_request.wall_ms }];
  }));
  result.parallel = { before: before.parallel, after: after.parallel };
  fs.writeFileSync(path.join(afterDirectory, 'comparison.json'), JSON.stringify(result, null, 2));
  console.log(`${result.days} days: canonical11 PASS; raw8 equal/3 volatile; 202 exact leaves; all11 bytes equal`);
}
module.exports = { compare };
