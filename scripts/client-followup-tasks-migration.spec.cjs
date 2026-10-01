const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

// Source contracts only; actual PostgreSQL new/legacy migration checks are separate.
const root = path.resolve(__dirname, '..');
const types = ['TRAINING_UPDATE', 'DIET_UPDATE', 'PHOTO_REVIEW', 'RECAP_REVIEW', 'REVIEW', 'CALL', 'FEEDBACK'];
const priorities = ['LOW', 'MEDIUM', 'HIGH'];
const statuses = ['PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'];
function sources() {
  return {
    schema: readFileSync(path.join(root, 'prisma/schema.prisma'), 'utf8'),
    sql: readFileSync(path.join(root, 'prisma/migrations/20260930230000_client_followup_tasks/migration.sql'), 'utf8'),
  };
}
function block(schema, kind, name) {
  const match = schema.match(new RegExp(`${kind} ${name} \\{([^}]+)\\}`));
  assert.ok(match, `${kind} ${name} must exist`);
  return match[1];
}

test('task enums have exactly the agreed values in Prisma and SQL', () => {
  const { schema, sql } = sources();
  for (const [name, values] of [
    ['ClientFollowUpTaskType', types],
    ['ClientFollowUpTaskPriority', priorities],
    ['ClientFollowUpTaskStatus', statuses],
  ]) {
    assert.deepEqual(block(schema, 'enum', name).trim().split(/\s+/), values);
    assert.ok(sql.includes(`CREATE TYPE "${name}" AS ENUM (${values.map(v => `'${v}'`).join(', ')});`));
  }
});

test('task fields preserve text user IDs, date precision, defaults and bounded content', () => {
  const { schema, sql } = sources();
  const model = block(schema, 'model', 'ClientFollowUpTask');
  assert.match(block(schema, 'model', 'User'), /\bid\s+String\s+@id\s+@default\(uuid\(\)\)(?![^\n]*@db\.Uuid)/);
  for (const field of [
    /\bid\s+String\s+@id\s+@default\(uuid\(\)\)/,
    /\bclient_id\s+String\s*\n/, /\bassigned_to_id\s+String\?/, /\bcreated_by_id\s+String\?/,
    /\btype\s+ClientFollowUpTaskType/, /\btitle\s+String\s+@db\.VarChar\(160\)/,
    /\bdescription\s+String\?\s+@db\.VarChar\(3000\)/,
    /\bdue_date\s+DateTime\s+@db\.Date/,
    /\bpriority\s+ClientFollowUpTaskPriority\s+@default\(MEDIUM\)/,
    /\bstatus\s+ClientFollowUpTaskStatus\s+@default\(PENDING\)/,
    /\bversion\s+Int\s+@default\(1\)/,
    /\bcompleted_at\s+DateTime\?\s+@db\.Timestamptz\(3\)/,
    /\bcancelled_at\s+DateTime\?\s+@db\.Timestamptz\(3\)/,
    /\bcreated_at\s+DateTime\s+@default\(now\(\)\)\s+@db\.Timestamptz\(3\)/,
    /\bupdated_at\s+DateTime\s+@updatedAt\s+@db\.Timestamptz\(3\)/,
  ]) assert.match(model, field);
  for (const column of [
    '"id" TEXT NOT NULL', '"client_id" TEXT NOT NULL', '"assigned_to_id" TEXT', '"created_by_id" TEXT',
    '"type" "ClientFollowUpTaskType" NOT NULL', '"title" VARCHAR(160) NOT NULL', '"description" VARCHAR(3000)',
    '"due_date" DATE NOT NULL', '"priority" "ClientFollowUpTaskPriority" NOT NULL DEFAULT \'MEDIUM\'',
    '"status" "ClientFollowUpTaskStatus" NOT NULL DEFAULT \'PENDING\'', '"version" INTEGER NOT NULL DEFAULT 1',
    '"completed_at" TIMESTAMPTZ(3)', '"cancelled_at" TIMESTAMPTZ(3)',
    '"created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP', '"updated_at" TIMESTAMPTZ(3) NOT NULL',
    'PRIMARY KEY ("id")',
  ]) assert.ok(sql.includes(column), column);
  assert.match(model, /@@map\("client_followup_tasks"\)/);
});

test('ownership cascades only for the client; deleted staff leave nullable attribution', () => {
  const { schema, sql } = sources();
  const model = block(schema, 'model', 'ClientFollowUpTask');
  const user = block(schema, 'model', 'User');
  for (const [field, relation, deletion] of [
    ['client_id', 'FollowUpTaskClient', 'Cascade'],
    ['assigned_to_id', 'FollowUpTaskAssignee', 'SetNull'],
    ['created_by_id', 'FollowUpTaskCreator', 'SetNull'],
  ]) {
    assert.ok(model.includes(`@relation("${relation}", fields: [${field}], references: [id], onDelete: ${deletion})`));
    assert.match(user, new RegExp(`ClientFollowUpTask\\[\\]\\s+@relation\\("${relation}"\\)`));
    assert.ok(sql.includes(`FOREIGN KEY ("${field}") REFERENCES "users"("id") ON DELETE ${deletion === 'Cascade' ? 'CASCADE' : 'SET NULL'} ON UPDATE CASCADE`));
  }
});

test('nonblank title, positive version and exact terminal timestamps are constrained', () => {
  const { sql } = sources();
  assert.ok(sql.includes('CHECK (length(btrim("title")) > 0)'));
  assert.ok(sql.includes('CHECK ("version" >= 1)'));
  for (const clause of [
    '"status" IN (\'PENDING\', \'IN_PROGRESS\') AND "completed_at" IS NULL AND "cancelled_at" IS NULL',
    '"status" = \'COMPLETED\' AND "completed_at" IS NOT NULL AND "cancelled_at" IS NULL',
    '"status" = \'CANCELLED\' AND "completed_at" IS NULL AND "cancelled_at" IS NOT NULL',
  ]) assert.ok(sql.includes(clause), clause);
});

test('shared queue indexes exist and migration contains only additive DDL', () => {
  const { schema, sql } = sources();
  const model = block(schema, 'model', 'ClientFollowUpTask');
  for (const fields of [
    ['client_id', 'status', 'due_date', 'priority', 'created_at'],
    ['client_id', 'type', 'status', 'due_date'],
  ]) {
    assert.ok(model.includes(`@@index([${fields.join(', ')}], map: "client_followup_tasks_${fields.includes('type') ? 'type_queue' : 'queue'}_idx")`));
    assert.ok(sql.includes(`ON "client_followup_tasks"(${fields.map(f => `"${f}"`).join(', ')})`));
  }
  assert.doesNotMatch(sql, /\b(DROP|TRUNCATE|INSERT|UPDATE|DELETE)\b(?!\s+(CASCADE|SET NULL))/);
  for (const statement of sql.split(';').map(s => s.trim()).filter(Boolean)) {
    assert.match(statement, /^CREATE (TYPE|TABLE|INDEX)\b/);
  }
  assert.equal((sql.match(/CREATE TABLE/g) || []).length, 1);
  assert.match(sql, /CREATE TABLE "client_followup_tasks"/);
});
