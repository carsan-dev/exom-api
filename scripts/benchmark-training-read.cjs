'use strict';

// Evidence-only SQL benchmark. Run only against the disposable exom_ci service;
// never load .env or call the HTTP API. Synthetic inserts always roll back.
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { databaseUrl, assertTestDatabase } = require('./test-database.cjs');

const FROM = '2024-01-01';
const TO = '2024-12-31';
const DAY_MS = 86400000;

function inclusiveDays(from, to) {
  const parse = (value) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw Error('Invalid range');
    const ms = Date.parse(`${value}T00:00:00.000Z`);
    if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value)
      throw Error('Invalid range');
    return ms;
  };
  const days = (parse(to) - parse(from)) / DAY_MS + 1;
  if (!Number.isInteger(days) || days < 1 || days > 366) throw Error('Invalid range');
  return days;
}

function scenario(name) {
  if (!['full_window', 'same_day_10k'].includes(name)) throw Error('Invalid scenario');
  const days = name === 'full_window' ? inclusiveDays(FROM, TO) : 1;
  const count = name === 'full_window' ? 20 : 10000;
  const exerciseIds = Array.from({ length: count }, () => randomUUID());
  const dayEntries = exerciseIds.map((exercise_id, index) => ({
    exercise_id, training_exercise_id: randomUUID(), training_session_id: randomUUID(),
    sets: Array.from({ length: 3 }, (_, set) => ({
      set_number: set + 1, reps: 8 + index % 4, weight_kg: 20 + index, rir: 2,
    })),
  }));
  return { name, days, entries: count, sets: 3, exerciseIds, dayEntries };
}

function parseArgs(args) {
  if (args.length === 1 && args[0] === '--preflight-only') return { preflightOnly: true };
  if (args.length === 0) return { preflightOnly: false };
  throw Error('Invalid argument');
}

function responseMetric(label, rows, wallMs) {
  // This is a serialized SQL row payload, NOT a real HTTP response.
  return { label, wall_ms: wallMs,
    serialized_response_bytes: Buffer.byteLength(JSON.stringify(rows)),
    http_response: false };
}

// Match #readExerciseLoadHistory in training-progress-read.service.ts: the
// first statement is its current exact count(*) integrity pre-scan. The next
// statement changes only the outer count to a boolean EXISTS over the same
// range and predicate; it is a comparison, not a proposed behavior change.
const integrityFrom = `FROM day_progress d
  WHERE d.client_id = $1 AND d.date >= $2::date AND d.date <= $3::date
    AND (jsonb_typeof(d.exercises_completed) IS DISTINCT FROM 'array'
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(d.exercises_completed) = 'array'
          THEN d.exercises_completed ELSE '[]'::jsonb END) e
        WHERE jsonb_typeof(e.value) IS DISTINCT FROM 'object'
          OR jsonb_typeof(e.value->'exercise_id') IS DISTINCT FROM 'string'
          OR (e.value ? 'sets' AND
            jsonb_typeof(e.value->'sets') IS DISTINCT FROM 'array')
          OR EXISTS (SELECT 1 FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(e.value->'sets') = 'array'
              THEN e.value->'sets' ELSE '[]'::jsonb END) s
            WHERE jsonb_typeof(s.value) IS DISTINCT FROM 'object'))) `;

const queries = [
  { label: 'overview_cardinality_mirror_not_actual_overview',
    // Mirrors the production overview's days -> entries -> valid raw sets ->
    // distinct-exercise aggregation, not its PR/name/session or all indicators.
    // Do not use this as evidence of the actual overview transaction's budget.
    text: `WITH days AS (
      SELECT date, exercises_completed FROM day_progress
      WHERE client_id = $1 AND date >= $2::date AND date <= $3::date
    ), entries AS (
      SELECT e.value AS entry FROM days d
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(d.exercises_completed) = 'array'
        THEN d.exercises_completed ELSE '[]'::jsonb END) e
      WHERE jsonb_typeof(e.value) = 'object'
        AND jsonb_typeof(e.value->'exercise_id') = 'string'
        AND length(e.value->>'exercise_id') > 0
        AND jsonb_typeof(e.value->'sets') = 'array'
    ), raw_sets AS (
      SELECT entry FROM entries CROSS JOIN LATERAL jsonb_array_elements(entry->'sets') s
      WHERE jsonb_typeof(s.value) = 'object'
        AND jsonb_typeof(s.value->'set_number') = 'number'
        AND (s.value->>'set_number')::numeric BETWEEN 1 AND 9007199254740991
        AND (s.value->>'set_number')::numeric = trunc((s.value->>'set_number')::numeric)
    ) SELECT entry->>'exercise_id' AS exercise_id, count(*) AS sets
      FROM raw_sets GROUP BY entry->>'exercise_id' ORDER BY exercise_id`,
    params: (id) => [id, FROM, TO], rows: true },
  { label: 'integrity_count', text: `SELECT count(*) AS invalid ${integrityFrom}`, params: (id, exercise) => [id, FROM, TO] },
  { label: 'integrity_exists', text: `SELECT EXISTS (SELECT 1 ${integrityFrom}) AS invalid`, params: (id, exercise) => [id, FROM, TO] },
  {
    label: 'load_page_26',
    // Current no-cursor first page, limit 25 + 1 sentinel. Preserve the null
    // cursor predicate and ordinal ordering of the production query.
    text: `SELECT d.date::text AS date, e.entry_index, s.set_index,
      e.value->>'training_session_id' AS training_session_id,
      e.value->>'training_exercise_id' AS training_exercise_id, s.value AS item
      FROM day_progress d
      CROSS JOIN LATERAL jsonb_array_elements(d.exercises_completed) WITH ORDINALITY e(value, entry_index)
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(e.value->'sets') = 'array'
          THEN e.value->'sets' ELSE '[]'::jsonb END) WITH ORDINALITY s(value, set_index)
      WHERE d.client_id = $1 AND d.date >= $2::date
        AND d.date <= $3::date AND e.value->>'exercise_id' = $4
        AND ($5::date IS NULL OR d.date < $5::date
          OR (d.date = $5::date AND
            (e.entry_index > $6::bigint OR
              (e.entry_index = $6::bigint AND s.set_index > $7::bigint))))
      ORDER BY d.date DESC, e.entry_index ASC, s.set_index ASC
      LIMIT $8`,
    params: (id, exercise) => [id, FROM, TO, exercise, null, null, null, 26],
  },
];

function safeName(name) {
  return typeof name === 'string' && /^[a-zA-Z_][a-zA-Z_0-9]*$/.test(name)
    ? name : 'redacted';
}

function summarize(label, explain, wallMs) {
  const root = explain.rows[0]['QUERY PLAN'][0];
  const scans = [];
  function visit(node) {
    if (node['Node Type'].includes('Scan')) {
      scans.push({ scan: safeName(node['Node Type'].replaceAll(' ', '_')),
        index: node['Index Name'] ? safeName(node['Index Name']) : null,
        rows: node['Actual Rows'], loops: node['Actual Loops'] });
    }
    for (const child of node.Plans || []) visit(child);
  }
  visit(root.Plan);
  // Never print the plan itself: predicates may contain bound synthetic IDs.
  return { label, wall_ms: wallMs, planning_ms: root['Planning Time'], execution_ms: root['Execution Time'],
    rows: root.Plan['Actual Rows'], shared_hit: root.Plan['Shared Hit Blocks'],
    shared_read: root.Plan['Shared Read Blocks'], shared_dirtied: root.Plan['Shared Dirtied Blocks'],
    shared_written: root.Plan['Shared Written Blocks'], local_hit: root.Plan['Local Hit Blocks'],
    local_read: root.Plan['Local Read Blocks'], temp_read: root.Plan['Temp Read Blocks'],
    temp_written: root.Plan['Temp Written Blocks'], scans };
}

async function run({ preflightOnly = false, pool: injectedPool, assertTarget = assertTestDatabase } = {}) {
  // databaseUrl validates the endpoint without printing it; assertTestDatabase
  // checks the actual database, role and data directory before the first write.
  let pool = injectedPool;
  if (!pool) {
    const target = new URL(databaseUrl());
    if (target.hostname !== '127.0.0.1' || target.port !== '55444' ||
      target.pathname !== '/exom_ci') throw new Error('WRONG_TARGET');
    pool = new Pool({ connectionString: target.toString(), connectionTimeoutMillis: 3000 });
  }
  let client;
  let began = false;
  const syntheticIds = [];
  let primaryError;
  let results;
  let stage = 'identity';
  let failedStage = 'identity';
  try {
    await assertTarget(pool);
    const version = await pool.query('SHOW server_version_num');
    const serverVersion = Number(version.rows[0]?.server_version_num);
    const migrations = await pool.query(`SELECT
      count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)::integer AS applied,
      count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL)::integer AS pending
      FROM _prisma_migrations`);
    if (serverVersion < 170000 || serverVersion >= 180000 ||
      migrations.rows[0]?.applied !== 79 || migrations.rows[0]?.pending !== 0) {
      throw new Error('WRONG_TARGET');
    }
    if (preflightOnly) return { preflight_only: true, target_verified: true };
    stage = 'connect';
    client = await pool.connect();
    stage = 'begin';
    await client.query('BEGIN');
    began = true;
    await client.query('SET LOCAL statement_timeout = 30000');
    results = [];
    for (const name of ['full_window', 'same_day_10k']) {
      const fixture = scenario(name);
      const fixtureId = randomUUID();
      syntheticIds.push(fixtureId);
      const fixtureDate = name === 'full_window' ? FROM : TO;
      stage = 'insert_user';
      await client.query(`INSERT INTO users (id, email, firebase_uid, role, updated_at)
        VALUES ($1, $2, $3, 'CLIENT', now())`,
      [fixtureId, `benchmark-${fixtureId}@example.invalid`, `benchmark-${fixtureId}`]);
      stage = 'insert_days';
      await client.query(`INSERT INTO day_progress
        (id, client_id, date, exercises_completed, meals_completed, updated_at)
        SELECT gen_random_uuid(), $1, $2::date + n, $3::jsonb, ARRAY[]::text[], now()
        FROM generate_series(0, $4::integer - 1) AS days(n)`,
      [fixtureId, fixtureDate, JSON.stringify(fixture.dayEntries), fixture.days]);
      for (const query of queries) {
        stage = query.label;
        const params = query.params(fixtureId, fixture.exerciseIds[0]);
        const start = process.hrtime.bigint();
        const plan = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.text}`, params);
        const wallMs = Number(process.hrtime.bigint() - start) / 1e6;
        results.push({ scenario: name, ...summarize(query.label, plan, wallMs) });
        if (query.rows) {
          const rowsStart = process.hrtime.bigint();
          const rows = await client.query(query.text, params);
          results.push({ scenario: name, ...responseMetric(query.label, rows.rows,
            Number(process.hrtime.bigint() - rowsStart) / 1e6) });
        }
      }
    }

  } catch (error) {
    primaryError = error;
    failedStage = stage;
  } finally {
    if (client) {
      try {
        stage = 'rollback';
        if (began) await client.query('ROLLBACK');
        for (const id of syntheticIds) {
          stage = 'residual';
          const residual = await client.query(`SELECT
            (SELECT count(*) FROM users WHERE id = $1) AS clients,
            (SELECT count(*) FROM day_progress WHERE client_id = $1) AS days`, [id]);
          if (residual.rows[0].clients !== '0' || residual.rows[0].days !== '0') {
            throw new Error('RESIDUAL_ROWS');
          }
        }
      } catch (error) {
        primaryError = error;
        failedStage = stage;
      } finally {
        client.release();
      }
    }
    try { await pool.end(); } catch (error) { primaryError = error; failedStage = 'pool_close'; }
  }
  if (primaryError) {
    primaryError.benchmarkStage = failedStage;
    throw primaryError;
  }
  return results;
}

module.exports = { inclusiveDays, scenario, parseArgs, summarize, responseMetric, run };

if (require.main === module) run(parseArgs(process.argv.slice(2))).then((results) => {
  if (Array.isArray(results)) for (const result of results) console.log(JSON.stringify(result));
  else console.log(JSON.stringify(results));
}).catch((error) => {
  // pg error messages can contain SQL/parameters/connection details. Only
  // PostgreSQL's fixed-width SQLSTATE (or a fixed internal marker) is safe.
  const code = typeof error.code === 'string' && /^[A-Z0-9]{5}$/.test(error.code)
    ? error.code : 'INTERNAL';
  const stage = typeof error.benchmarkStage === 'string' &&
    /^[a-z_]+$/.test(error.benchmarkStage) ? error.benchmarkStage : 'internal';
  console.error(`benchmark_failed stage=${stage} code=${code}`);
  process.exitCode = 1;
});
