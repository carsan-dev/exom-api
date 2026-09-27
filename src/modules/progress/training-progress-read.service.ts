import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Prisma, PrismaClient, Role } from '@prisma/client';
import {
  assertTrainingOverviewResponseBound,
  assertTrainingOverviewWorkBound,
  TRAINING_OVERVIEW_MAX_DISTINCT_EXERCISES,
} from './training-overview-bounds';
import {
  encodeTrainingOverviewCursor,
  validateTrainingOverviewPage,
} from './training-overview-pagination';

export interface TrainingProgressRange {
  from: string;
  to: string;
}

export interface ExerciseLoadSet {
  date: string;
  training_session_id: string | null;
  training_exercise_id: string | null;
  set_number: number | null;
  reps: number | null;
  seconds: number | null;
  weight_kg: number | null;
  rir: number | null;
  volume: number | null;
}

export interface ExerciseLoadPage {
  page: ExerciseLoadSet[];
  nextCursor: string | null;
}

interface LoadCursor {
  v: 1;
  c: string;
  e: string;
  f: string;
  t: string;
  d: string;
  i: number;
  s: number;
}

export interface TrainingSessionDetail {
  training_id: string;
  training_session_id: string;
  training_name: string | null;
  rpe: number | null;
  note: string | null;
  page: Array<{
    exercise_id: string;
    exercise_name: string | null;
    training_exercise_id: string | null;
    set_number: number | null;
    reps: number | null;
    seconds: number | null;
    weight_kg: number | null;
    rir: number | null;
  }>;
  nextCursor: string | null;
}

export interface TrainingSessionListPage {
  page: Array<{
    date: string;
    training_id: string;
    training_session_id: string;
    training_name: string | null;
    rpe: number | null;
    note: string | null;
  }>;
  nextCursor: string | null;
}

interface SessionListCursor {
  v: 1;
  c: string;
  f: string;
  t: string;
  d: string;
  i: number;
}

interface SessionListKey {
  date: string;
  entry_index: bigint;
  training_session_id: string;
}

interface SessionListRow {
  date: string;
  training_session_id: string;
  item: unknown;
  payload: unknown;
}

interface SessionCursor {
  v: 1;
  c: string;
  d: string;
  s: string;
  i: number;
  j: number;
}

interface SessionSetRow {
  entry_index: bigint;
  set_index: bigint;
  exercise_id: string | null;
  training_exercise_id: string | null;
  item: unknown;
}

interface RawLoadSet {
  date: string;
  entry_index: bigint;
  set_index: bigint;
  training_session_id: string | null;
  training_exercise_id: string | null;
  item: unknown;
}

function loadNumber(value: unknown, name: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw new BadRequestException(`Malformed historical ${name}`);
  return value;
}

function loadString(value: unknown, name: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !value.length)
    throw new BadRequestException(`Malformed historical ${name}`);
  return value;
}

function snapshotObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function snapshotLabel(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function snapshotExerciseName(
  payload: Record<string, unknown> | null,
  exerciseId: string,
  occurrenceId: string | null,
): string | null {
  if (!Array.isArray(payload?.exercises)) return null;
  const matches = payload.exercises.filter((value: unknown) => {
    const entry = snapshotObject(value);
    return (
      entry?.exercise_id === exerciseId &&
      (occurrenceId === null || entry.id === occurrenceId)
    );
  });
  // An absent occurrence ID cannot identify one of several prescriptions of
  // the same exercise; duplicate occurrence IDs are ambiguous too.
  if (matches.length !== 1) return null;
  return snapshotLabel(
    snapshotObject(snapshotObject(matches[0])?.exercise)?.name,
  );
}

export interface TrainingExerciseSummary {
  exercise_id: string;
  exercise_name: string | null;
  sets: number;
  max_reps: number | null;
  max_seconds: number | null;
  volume: number | null;
  mean_rir: number | null;
  pr: {
    weight_kg: number;
    reps: number;
    date: string;
    training_session_id: string | null;
    set_number: number;
  } | null;
}

export interface TrainingReadOverview {
  indicators: {
    trainings_completed: number;
    volume: number | null;
    mean_rir: number | null;
    mean_rpe: number | null;
  };
  exercises: TrainingExerciseSummary[];
  next_cursor?: string | null;
}

const MAX_FLOAT = '1.7976931348623157e308';

// Counts are exact in PostgreSQL; do not silently round them in the API.
export function safeBigintCount(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(
      'PostgreSQL count exceeds JavaScript safe integer range',
    );
  }
  return Number(value);
}
const validDate = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
};

const MAX_INCLUSIVE_RANGE_DAYS = 366;
const UTC_DAY_MS = 24 * 60 * 60 * 1000;

function validCivilDateRange(range: TrainingProgressRange): boolean {
  if (!validDate(range.from) || !validDate(range.to) || range.from > range.to)
    return false;
  const from = Date.parse(`${range.from}T00:00:00.000Z`);
  const to = Date.parse(`${range.to}T00:00:00.000Z`);
  return (to - from) / UTC_DAY_MS + 1 <= MAX_INCLUSIVE_RANGE_DAYS;
}

// PostgreSQL does not allow a window result to be implicitly treated as a finite JS
// number. Cast only after testing the aggregate against the float64 boundary.
interface RawExercise {
  exercise_id: string | null;
  exercise_name: string | null;
  sets: bigint;
  max_reps: number | null;
  max_seconds: number | null;
  volume: number | null;
  mean_rir: number | null;
  pr_weight: number | null;
  pr_reps: number | null;
  pr_date: string | null;
  pr_session: string | null;
  pr_set: number | null;
  total_rir: string | null;
  rir_count: bigint;
  overall_volume: number | null;
  overall_rir_total: string | null;
  overall_rir_count: bigint | null;
}

interface RawSessions {
  completed: bigint;
  rpe_total: string | null;
  rpe_count: bigint;
}

// Shared verbatim by the production read and the isolated query-plan probe.
export function buildTrainingOverviewExerciseQuery(
  clientId: string,
  range: TrainingProgressRange,
  page?: { limit: number; lastExerciseId: string | null },
): Prisma.Sql {
  return Prisma.sql`
      WITH days AS (
        SELECT date, exercises_completed, training_sessions, trainings_completed
        FROM day_progress
        WHERE client_id = ${clientId} AND date >= ${range.from}::date AND date <= ${range.to}::date
      ), entries AS (
        SELECT d.date, d.training_sessions, e.value AS entry FROM days d
        CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(d.exercises_completed) = 'array'
          THEN d.exercises_completed ELSE '[]'::jsonb END) e
        WHERE jsonb_typeof(e.value) = 'object'
          AND jsonb_typeof(e.value->'exercise_id') = 'string'
          AND length(e.value->>'exercise_id') > 0
          AND jsonb_typeof(e.value->'sets') = 'array'
      ), raw_sets AS (
        SELECT date, training_sessions, entry, s.value AS item FROM entries
        CROSS JOIN LATERAL jsonb_array_elements(entry->'sets') s
        WHERE jsonb_typeof(s.value) = 'object'
          AND jsonb_typeof(s.value->'set_number') = 'number'
          AND (s.value->>'set_number')::numeric BETWEEN 1 AND 9007199254740991
          AND (s.value->>'set_number')::numeric = trunc((s.value->>'set_number')::numeric)
      ), parsed AS (
        SELECT date, training_sessions, entry, entry->>'exercise_id' AS exercise_id,
          CASE WHEN jsonb_typeof(entry->'training_session_id') = 'string'
            AND length(entry->>'training_session_id') > 0 THEN entry->>'training_session_id' END AS session_id,
          CASE WHEN jsonb_typeof(entry->'training_exercise_id') = 'string'
            THEN entry->>'training_exercise_id' END AS assignment_id,
          CASE WHEN jsonb_typeof(entry->'completed_at') = 'string'
            THEN entry->>'completed_at' END AS completed_at,
          (item->>'set_number')::numeric AS set_number,
          CASE WHEN jsonb_typeof(item->'seconds') = 'number'
            AND (item->>'seconds')::numeric BETWEEN 1 AND 9007199254740991
            AND (item->>'seconds')::numeric = trunc((item->>'seconds')::numeric)
            THEN (item->>'seconds')::numeric END AS seconds,
          CASE WHEN (item->'seconds' IS NULL OR jsonb_typeof(item->'seconds') = 'null')
            AND jsonb_typeof(item->'reps') = 'number'
            AND (item->>'reps')::numeric BETWEEN 1 AND 9007199254740991
            AND (item->>'reps')::numeric = trunc((item->>'reps')::numeric)
            THEN (item->>'reps')::numeric END AS reps,
          CASE WHEN jsonb_typeof(item->'weight_kg') = 'number'
            AND (item->>'weight_kg')::numeric BETWEEN 0 AND ${MAX_FLOAT}::numeric
            THEN (item->>'weight_kg')::numeric END AS weight,
          CASE WHEN jsonb_typeof(item->'rir') = 'number'
            AND (item->>'rir')::numeric BETWEEN 0 AND 10
            AND (item->>'rir')::numeric = trunc((item->>'rir')::numeric)
            THEN (item->>'rir')::numeric END AS rir
        FROM raw_sets
      ), terms AS (
        SELECT *, CASE WHEN reps IS NOT NULL AND weight IS NOT NULL
          AND weight * reps <= ${MAX_FLOAT}::numeric THEN weight * reps END AS term
        FROM parsed
      ), grouped AS (
        SELECT exercise_id, count(*) AS sets, max(reps) AS max_reps,
          max(seconds) AS max_seconds, sum(term) AS total_volume,
          bool_or(reps IS NOT NULL AND weight IS NOT NULL AND term IS NULL) AS overflow,
          sum(rir) AS total_rir, count(rir) AS rir_count
        FROM terms GROUP BY exercise_id
      ), ${
        page
          ? Prisma.sql`page_ids AS (
        SELECT exercise_id FROM grouped
        WHERE (${page.lastExerciseId}::text IS NULL
          OR exercise_id > ${page.lastExerciseId}::text)
        ORDER BY exercise_id LIMIT ${page.limit + 1}
      ),`
          : Prisma.empty
      } globals AS (
        SELECT bool_or(overflow) AS overflow, sum(total_volume) AS total_volume,
          sum(total_rir) AS total_rir, sum(rir_count) AS rir_count
        FROM grouped
      ), prs AS MATERIALIZED (
        SELECT DISTINCT ON (t.exercise_id) t.exercise_id, weight, reps, date, session_id, set_number
        FROM terms t ${page ? Prisma.sql`JOIN page_ids ids ON ids.exercise_id = t.exercise_id` : Prisma.empty}
        WHERE weight IS NOT NULL AND reps IS NOT NULL
        ORDER BY t.exercise_id, weight DESC, reps DESC, date DESC,
          session_id ASC NULLS FIRST, assignment_id ASC NULLS FIRST,
          completed_at ASC NULLS FIRST, set_number ASC
      ), performed_entries AS (
        SELECT DISTINCT date, t.exercise_id, entry, training_sessions
        FROM terms t ${page ? Prisma.sql`JOIN page_ids ids ON ids.exercise_id = t.exercise_id` : Prisma.empty}
      ), entry_names AS (
        SELECT e.date, e.exercise_id, n.exercise_name
        FROM performed_entries e
        LEFT JOIN LATERAL (
          SELECT CASE WHEN count(*) = 1 THEN min(claim->>'training_id') END AS training_id
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e.training_sessions) = 'array'
            THEN e.training_sessions ELSE '[]'::jsonb END) claim
          WHERE jsonb_typeof(claim) = 'object'
            AND jsonb_typeof(e.entry->'training_session_id') = 'string'
            AND length(e.entry->>'training_session_id') > 0
            AND claim->>'training_session_id' = e.entry->>'training_session_id'
            AND jsonb_typeof(claim->'training_id') = 'string'
            AND length(claim->>'training_id') > 0
            AND (NOT (claim ? 'confirmed') OR claim->'confirmed' = 'true'::jsonb)
        ) session_claim ON true
        LEFT JOIN training_day_snapshots snapshot ON snapshot.client_id = ${clientId}
          AND snapshot.date = e.date AND snapshot.training_id = session_claim.training_id
          AND snapshot.version = 1
        LEFT JOIN LATERAL (
          SELECT CASE WHEN count(*) = 1
            AND count(*) FILTER (WHERE jsonb_typeof(p.value->'exercise') = 'object'
              AND jsonb_typeof(p.value->'exercise'->'name') = 'string'
              AND length(p.value->'exercise'->>'name') > 0) = 1
            THEN min(p.value->'exercise'->>'name') END AS exercise_name
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(snapshot.payload->'exercises') = 'array'
            THEN snapshot.payload->'exercises' ELSE '[]'::jsonb END) p
          WHERE jsonb_typeof(e.entry->'training_exercise_id') = 'string'
            AND length(e.entry->>'training_exercise_id') > 0
            AND p.value->>'id' = e.entry->>'training_exercise_id'
            AND p.value->>'exercise_id' = e.exercise_id
        ) n ON true
      ), day_names AS (
        SELECT exercise_id, date,
          CASE WHEN count(exercise_name) = count(*) AND count(DISTINCT exercise_name) = 1
            THEN min(exercise_name) END AS exercise_name
        FROM entry_names GROUP BY exercise_id, date
      ), latest_names AS MATERIALIZED (
        SELECT DISTINCT ON (exercise_id) exercise_id, exercise_name
        FROM day_names ORDER BY exercise_id, date DESC
      )
      SELECT g.exercise_id, n.exercise_name, g.sets,
        CASE WHEN g.max_reps <= 9007199254740991
          THEN g.max_reps::float8 END AS max_reps,
        CASE WHEN g.max_seconds <= 9007199254740991
          THEN g.max_seconds::float8 END AS max_seconds,
        CASE WHEN NOT g.overflow AND g.total_volume <= ${MAX_FLOAT}::numeric
          THEN g.total_volume::float8 END AS volume,
        CASE WHEN NOT globals.overflow
          AND globals.total_volume <= ${MAX_FLOAT}::numeric
          THEN globals.total_volume::float8 END AS overall_volume,
        globals.total_rir::text AS overall_rir_total,
        globals.rir_count AS overall_rir_count,
        CASE WHEN g.rir_count > 0 THEN (g.total_rir / g.rir_count)::float8 END AS mean_rir,
        p.weight::float8 AS pr_weight, p.reps::float8 AS pr_reps,
        p.date::text AS pr_date, p.session_id AS pr_session,
        p.set_number::float8 AS pr_set, g.total_rir::text AS total_rir,
        g.rir_count
      ${
        page
          ? Prisma.sql`FROM globals LEFT JOIN page_ids ids ON true
        LEFT JOIN grouped g ON g.exercise_id = ids.exercise_id`
          : Prisma.sql`FROM globals LEFT JOIN grouped g ON true`
      }
        LEFT JOIN prs p ON p.exercise_id = g.exercise_id
        LEFT JOIN latest_names n ON n.exercise_id = g.exercise_id
      ORDER BY g.exercise_id
    `;
}

export class TrainingProgressReadService {
  constructor(private readonly db: Pick<PrismaClient, '$transaction'>) {}

  async #assertReadAccess(
    tx: Prisma.TransactionClient,
    actorId: string,
    targetId: string,
  ): Promise<void> {
    // Do not trust a role from a request or a prior transaction. Both users and
    // the assignment must come from the same snapshot as the progress data.
    const actor = actorId
      ? await tx.user.findUnique({
          where: { id: actorId },
          select: {
            role: true,
            is_active: true,
            is_locked: true,
            is_archived: true,
          },
        })
      : null;
    if (!actor || !actor.is_active || actor.is_locked || actor.is_archived)
      throw new ForbiddenException('Training progress access denied');
    const target = targetId
      ? await tx.user.findUnique({
          where: { id: targetId },
          select: {
            role: true,
            is_active: true,
            is_locked: true,
            is_archived: true,
          },
        })
      : null;
    if (
      !target ||
      target.role !== Role.CLIENT ||
      !target.is_active ||
      target.is_locked ||
      target.is_archived
    )
      throw new ForbiddenException('Training progress access denied');
    if (actor.role === Role.CLIENT && actorId === targetId) return;
    if (actor.role === Role.SUPER_ADMIN) return;
    if (actor.role === Role.ADMIN) {
      const assignment = await tx.adminClientAssignment.findFirst({
        where: { admin_id: actorId, client_id: targetId, is_active: true },
        select: { id: true },
      });
      if (assignment) return;
    }
    throw new ForbiddenException('Training progress access denied');
  }

  getAuthorizedOverview(
    actorId: string,
    targetId: string,
    range: TrainingProgressRange,
    options: { limit?: number; cursor?: string } = {},
  ): Promise<TrainingReadOverview> {
    return this.db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        return this.getAuthorizedOverviewInTransaction(
          tx,
          actorId,
          targetId,
          range,
          options,
        );
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        timeout: 30_000,
      },
    );
  }

  getAuthorizedExerciseLoadHistory(
    actorId: string,
    targetId: string,
    exerciseId: string,
    range: TrainingProgressRange,
    options: { limit?: number; cursor?: string } = {},
  ): Promise<ExerciseLoadPage> {
    return this.db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        await this.#assertReadAccess(tx, actorId, targetId);
        return this.#readExerciseLoadHistory(
          tx,
          targetId,
          exerciseId,
          range,
          options,
        );
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        timeout: 30_000,
      },
    );
  }

  getAuthorizedSessionList(
    actorId: string,
    clientId: string,
    range: TrainingProgressRange,
    options: { limit?: number; cursor?: string } = {},
  ): Promise<TrainingSessionListPage> {
    return this.db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        await this.#assertReadAccess(tx, actorId, clientId);
        return this.#readSessionList(tx, clientId, range, options);
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        timeout: 30_000,
      },
    );
  }

  async #readSessionList(
    tx: Prisma.TransactionClient,
    clientId: string,
    range: TrainingProgressRange,
    options: { limit?: number; cursor?: string },
  ): Promise<TrainingSessionListPage> {
    if (!clientId || !validCivilDateRange(range))
      throw new BadRequestException('Invalid civil date range');
    const limit = options.limit ?? 25;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new BadRequestException('Invalid page limit');
    let cursor: SessionListCursor | null = null;
    if (options.cursor !== undefined) {
      try {
        if (
          typeof options.cursor !== 'string' ||
          options.cursor.length > 2048 ||
          !/^[A-Za-z0-9_-]+$/.test(options.cursor)
        )
          throw Error('Invalid encoding');
        const bytes = Buffer.from(options.cursor, 'base64url');
        if (bytes.toString('base64url') !== options.cursor)
          throw Error('Non-canonical cursor');
        const decoded: unknown = JSON.parse(bytes.toString('utf8'));
        if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded))
          throw Error('Invalid cursor');
        const value = decoded as Partial<SessionListCursor>;
        if (
          value.v !== 1 ||
          value.c !== clientId ||
          value.f !== range.from ||
          value.t !== range.to ||
          typeof value.d !== 'string' ||
          !validDate(value.d) ||
          value.d < range.from ||
          value.d > range.to ||
          !Number.isSafeInteger(value.i) ||
          (value.i ?? 0) < 1
        )
          throw Error('Cursor mismatch');
        cursor = value as SessionListCursor;
      } catch {
        throw new BadRequestException('Invalid training session list cursor');
      }
    }
    // Group before keyset pagination: an ordinal after the cursor must not
    // resurrect a session whose first claim belonged to an earlier page.
    const keys = await tx.$queryRaw<SessionListKey[]>(Prisma.sql`
      WITH entries AS (
        SELECT d.date, e.entry_index, e.value AS item,
          e.value->>'training_session_id' AS session_id
        FROM day_progress d
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(d.training_sessions) = 'array'
            THEN d.training_sessions ELSE '[]'::jsonb END)
          WITH ORDINALITY e(value, entry_index)
        WHERE d.client_id = ${clientId} AND d.date >= ${range.from}::date
          AND d.date <= ${range.to}::date
          AND jsonb_typeof(e.value) = 'object'
          AND jsonb_typeof(e.value->'training_session_id') = 'string'
          AND length(e.value->>'training_session_id') > 0
      ), groups AS (
        SELECT date, session_id AS training_session_id,
          min(entry_index) AS entry_index
        FROM entries GROUP BY date, session_id
        HAVING bool_or(item->'confirmed' IS DISTINCT FROM 'false'::jsonb)
      )
      SELECT date::text AS date, entry_index, training_session_id
      FROM groups
      WHERE (${cursor?.d ?? null}::date IS NULL OR date < ${cursor?.d ?? null}::date
        OR (date = ${cursor?.d ?? null}::date AND entry_index > ${cursor?.i ?? null}::bigint))
      ORDER BY date DESC, entry_index ASC LIMIT ${limit + 1}
    `);
    const pageKeys = keys.slice(0, limit);
    // Only claims belonging to the selected groups cross into Node. All
    // duplicates (including false and malformed claims) are validated together.
    const rows = pageKeys.length
      ? await tx.$queryRaw<SessionListRow[]>(Prisma.sql`
          SELECT d.date::text AS date,
            e.value->>'training_session_id' AS training_session_id,
            e.value AS item, s.payload
          FROM day_progress d
          CROSS JOIN LATERAL jsonb_array_elements(
            CASE WHEN jsonb_typeof(d.training_sessions) = 'array'
              THEN d.training_sessions ELSE '[]'::jsonb END) e
          LEFT JOIN training_day_snapshots s ON s.client_id = d.client_id
            AND s.date = d.date AND s.training_id = e.value->>'training_id'
            AND s.version = 1
          WHERE d.client_id = ${clientId} AND (
            ${Prisma.join(
              pageKeys.map(
                (key) => Prisma.sql`(
              d.date = ${key.date}::date
              AND e.value->>'training_session_id' = ${key.training_session_id}
            )`,
              ),
              ' OR ',
            )}
          )
        `)
      : [];
    const page = pageKeys.map((key) => {
      let claim: {
        training_id: string;
        rpe: number | null;
        note: string | null;
        training_name: string | null;
      } | null = null;
      for (const row of rows) {
        if (
          row.date !== key.date ||
          row.training_session_id !== key.training_session_id
        )
          continue;
        const item = snapshotObject(row.item);
        if (
          !item ||
          typeof item.training_id !== 'string' ||
          !item.training_id ||
          typeof item.training_session_id !== 'string' ||
          !item.training_session_id ||
          (item.confirmed !== undefined &&
            typeof item.confirmed !== 'boolean') ||
          (item.rpe !== undefined &&
            item.rpe !== null &&
            (typeof item.rpe !== 'number' ||
              !Number.isInteger(item.rpe) ||
              item.rpe < 1 ||
              item.rpe > 10)) ||
          (item.note !== undefined &&
            item.note !== null &&
            typeof item.note !== 'string')
        )
          throw new BadRequestException('Malformed historical session claim');
        if (item.confirmed === false) continue;
        const candidate = {
          training_id: item.training_id,
          rpe: typeof item.rpe === 'number' ? item.rpe : null,
          note: typeof item.note === 'string' ? item.note : null,
          training_name: snapshotLabel(snapshotObject(row.payload)?.name),
        };
        if (
          claim &&
          (claim.training_id !== candidate.training_id ||
            claim.rpe !== candidate.rpe ||
            claim.note !== candidate.note)
        )
          throw new BadRequestException('Contradictory session claims');
        claim = candidate;
      }
      if (!claim)
        throw new BadRequestException('Malformed historical session claim');
      return {
        date: key.date,
        training_id: claim.training_id,
        training_session_id: key.training_session_id,
        training_name: claim.training_name,
        rpe: claim.rpe,
        note: claim.note,
      };
    });
    const last = pageKeys.at(-1);
    const nextCursor =
      keys.length > limit && last
        ? Buffer.from(
            JSON.stringify({
              v: 1,
              c: clientId,
              f: range.from,
              t: range.to,
              d: last.date,
              i: safeBigintCount(last.entry_index),
            } satisfies SessionListCursor),
          ).toString('base64url')
        : null;
    return { page, nextCursor };
  }

  getAuthorizedSessionDetail(
    actorId: string,
    clientId: string,
    date: string,
    sessionId: string,
    options: { limit?: number; cursor?: string } = {},
  ): Promise<TrainingSessionDetail | null> {
    return this.db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        await this.#assertReadAccess(tx, actorId, clientId);
        return this.#readSessionDetail(tx, clientId, date, sessionId, options);
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        timeout: 30_000,
      },
    );
  }

  async #readSessionDetail(
    tx: Prisma.TransactionClient,
    clientId: string,
    date: string,
    sessionId: string,
    options: { limit?: number; cursor?: string },
  ): Promise<TrainingSessionDetail | null> {
    if (!validDate(date) || !sessionId)
      throw new BadRequestException('Invalid session detail request');
    const limit = options.limit ?? 25;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new BadRequestException('Invalid page limit');
    let cursor: SessionCursor | null = null;
    if (options.cursor !== undefined) {
      try {
        if (
          typeof options.cursor !== 'string' ||
          options.cursor.length > 2048 ||
          !/^[A-Za-z0-9_-]+$/.test(options.cursor)
        )
          throw Error('Invalid encoding');
        const bytes = Buffer.from(options.cursor, 'base64url');
        if (bytes.toString('base64url') !== options.cursor)
          throw Error('Non-canonical cursor');
        const decoded: unknown = JSON.parse(bytes.toString('utf8'));
        if (!decoded || typeof decoded !== 'object')
          throw Error('Invalid cursor');
        const value = decoded as Partial<SessionCursor>;
        if (
          value.v !== 1 ||
          value.c !== clientId ||
          value.d !== date ||
          value.s !== sessionId ||
          !Number.isSafeInteger(value.i) ||
          !Number.isSafeInteger(value.j) ||
          (value.i ?? 0) < 1 ||
          (value.j ?? 0) < 1
        )
          throw Error('Cursor mismatch');
        cursor = value as SessionCursor;
      } catch {
        throw new BadRequestException('Invalid session detail cursor');
      }
    }
    const [day] = await tx.$queryRaw<
      { training_sessions: unknown; invalid: boolean }[]
    >`
      SELECT training_sessions,
        jsonb_typeof(training_sessions) IS DISTINCT FROM 'array' AS invalid
      FROM day_progress WHERE client_id = ${clientId} AND date = ${date}::date
    `;
    if (!day) return null;
    if (day.invalid || !Array.isArray(day.training_sessions))
      throw new BadRequestException('Malformed historical sessions');
    let claim: {
      training_id: string;
      rpe: number | null;
      note: string | null;
    } | null = null;
    let contradicted = false;
    for (const raw of day.training_sessions) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new BadRequestException('Malformed historical sessions');
      }
      const item = raw as Record<string, unknown>;
      if (item.training_session_id !== sessionId) continue;
      if (
        typeof item.training_id !== 'string' ||
        !item.training_id ||
        (item.confirmed !== undefined && typeof item.confirmed !== 'boolean') ||
        (item.rpe !== undefined &&
          item.rpe !== null &&
          (typeof item.rpe !== 'number' ||
            !Number.isInteger(item.rpe) ||
            item.rpe < 1 ||
            item.rpe > 10)) ||
        (item.note !== undefined &&
          item.note !== null &&
          typeof item.note !== 'string')
      )
        throw new BadRequestException('Malformed historical session claim');
      if (item.confirmed === false) continue;
      const candidate = {
        training_id: item.training_id,
        rpe: item.rpe ?? null,
        note: item.note ?? null,
      };
      if (
        claim &&
        (claim.training_id !== candidate.training_id ||
          claim.rpe !== candidate.rpe ||
          claim.note !== candidate.note)
      )
        contradicted = true;
      claim = candidate;
    }
    if (contradicted)
      throw new BadRequestException('Contradictory session claims');
    if (!claim) return null;
    const [snapshot] = await tx.$queryRaw<{ payload: unknown }[]>`
      SELECT payload FROM training_day_snapshots
      WHERE client_id = ${clientId} AND date = ${date}::date
        AND training_id = ${claim.training_id} AND version = 1
    `;
    const payload = snapshotObject(snapshot?.payload);
    const trainingName = snapshotLabel(payload?.name);
    const [integrity] = await tx.$queryRaw<{ invalid: bigint }[]>`
      SELECT count(*) AS invalid FROM day_progress d
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(d.exercises_completed) = 'array'
          THEN d.exercises_completed ELSE '[]'::jsonb END) e
      WHERE d.client_id = ${clientId} AND d.date = ${date}::date
        AND jsonb_typeof(e.value) = 'object'
        AND e.value->>'training_session_id' = ${sessionId}
        AND (jsonb_typeof(e.value->'exercise_id') IS DISTINCT FROM 'string'
          OR length(e.value->>'exercise_id') = 0
          OR (e.value ? 'sets' AND
            jsonb_typeof(e.value->'sets') IS DISTINCT FROM 'array')
          OR EXISTS (SELECT 1 FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(e.value->'sets') = 'array'
              THEN e.value->'sets' ELSE '[]'::jsonb END) s
            WHERE jsonb_typeof(s.value) IS DISTINCT FROM 'object'))
    `;
    if (integrity.invalid > 0n)
      throw new BadRequestException('Malformed historical exercise arrays');
    const rows = await tx.$queryRaw<SessionSetRow[]>(Prisma.sql`
      SELECT e.entry_index, s.set_index, e.value->>'exercise_id' AS exercise_id,
        e.value->>'training_exercise_id' AS training_exercise_id, s.value AS item
      FROM day_progress d
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(d.exercises_completed) = 'array'
          THEN d.exercises_completed ELSE '[]'::jsonb END)
        WITH ORDINALITY e(value, entry_index)
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(e.value->'sets') = 'array'
          THEN e.value->'sets' ELSE '[]'::jsonb END)
        WITH ORDINALITY s(value, set_index)
      WHERE d.client_id = ${clientId} AND d.date = ${date}::date
        AND e.value->>'training_session_id' = ${sessionId}
        AND (${cursor?.i ?? null}::bigint IS NULL OR
          e.entry_index > ${cursor?.i ?? null}::bigint OR
          (e.entry_index = ${cursor?.i ?? null}::bigint AND
            s.set_index > ${cursor?.j ?? null}::bigint))
      ORDER BY e.entry_index, s.set_index LIMIT ${limit + 1}
    `);
    const page = rows.slice(0, limit).map((row) => {
      if (!row.item || typeof row.item !== 'object' || Array.isArray(row.item))
        throw new BadRequestException('Malformed historical set');
      const item = row.item as Record<string, unknown>;
      const setNumber = loadNumber(item.set_number, 'set_number');
      if (
        setNumber !== null &&
        (!Number.isSafeInteger(setNumber) || setNumber < 1)
      )
        throw new BadRequestException('Malformed historical set_number');
      const seconds = loadNumber(item.seconds, 'seconds');
      if (seconds !== null && (!Number.isSafeInteger(seconds) || seconds < 1))
        throw new BadRequestException('Malformed historical seconds');
      const storedReps = loadNumber(item.reps, 'reps');
      if (
        storedReps !== null &&
        (!Number.isSafeInteger(storedReps) || storedReps < 1)
      )
        throw new BadRequestException('Malformed historical reps');
      const weight = loadNumber(item.weight_kg, 'weight_kg');
      const rir = loadNumber(item.rir, 'rir');
      if (rir !== null && (!Number.isInteger(rir) || rir > 10))
        throw new BadRequestException('Malformed historical rir');
      const exerciseId = loadString(row.exercise_id, 'exercise_id')!;
      const occurrenceId = loadString(
        row.training_exercise_id,
        'training_exercise_id',
      );
      return {
        exercise_id: exerciseId,
        exercise_name: snapshotExerciseName(payload, exerciseId, occurrenceId),
        training_exercise_id: occurrenceId,
        set_number: setNumber,
        reps: seconds === null ? storedReps : null,
        seconds,
        weight_kg: weight,
        rir,
      };
    });
    const last = rows.slice(0, limit).at(-1);
    const nextCursor =
      rows.length > limit && last
        ? Buffer.from(
            JSON.stringify({
              v: 1,
              c: clientId,
              d: date,
              s: sessionId,
              i: safeBigintCount(last.entry_index),
              j: safeBigintCount(last.set_index),
            } satisfies SessionCursor),
          ).toString('base64url')
        : null;
    return {
      training_id: claim.training_id,
      training_session_id: sessionId,
      training_name: trainingName,
      rpe: claim.rpe,
      note: claim.note,
      page,
      nextCursor,
    };
  }

  async #readExerciseLoadHistory(
    tx: Prisma.TransactionClient,
    clientId: string,
    exerciseId: string,
    range: TrainingProgressRange,
    options: { limit?: number; cursor?: string } = {},
  ): Promise<ExerciseLoadPage> {
    if (!clientId || !exerciseId || !validCivilDateRange(range))
      throw new BadRequestException('Invalid exercise load range');
    const limit = options.limit ?? 25;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new BadRequestException('Invalid page limit');
    let cursor: LoadCursor | null = null;
    if (options.cursor !== undefined) {
      try {
        if (
          typeof options.cursor !== 'string' ||
          options.cursor.length > 2048 ||
          !/^[A-Za-z0-9_-]+$/.test(options.cursor)
        )
          throw Error('Invalid encoding');
        const bytes = Buffer.from(options.cursor, 'base64url');
        if (bytes.toString('base64url') !== options.cursor)
          throw Error('Non-canonical cursor');
        const decoded: unknown = JSON.parse(bytes.toString('utf8'));
        if (!decoded || typeof decoded !== 'object')
          throw Error('Invalid cursor');
        const value = decoded as Partial<LoadCursor>;
        if (
          value.v !== 1 ||
          value.c !== clientId ||
          value.e !== exerciseId ||
          value.f !== range.from ||
          value.t !== range.to ||
          typeof value.d !== 'string' ||
          !validDate(value.d) ||
          value.d < range.from ||
          value.d > range.to ||
          !Number.isSafeInteger(value.i) ||
          !Number.isSafeInteger(value.s) ||
          (value.i ?? 0) < 1 ||
          (value.s ?? 0) < 1
        )
          throw Error('Cursor mismatch');
        cursor = value as LoadCursor;
      } catch {
        throw new BadRequestException('Invalid exercise load cursor');
      }
    }
    // Reject malformed historical arrays instead of silently presenting a partial history.
    const [integrity] = await tx.$queryRaw<{ invalid: bigint }[]>`
      SELECT count(*) AS invalid FROM day_progress d
      WHERE d.client_id = ${clientId} AND d.date >= ${range.from}::date AND d.date <= ${range.to}::date
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
                WHERE jsonb_typeof(s.value) IS DISTINCT FROM 'object')))
    `;
    if (integrity.invalid > 0n)
      throw new BadRequestException('Malformed historical exercise arrays');
    const rows = await tx.$queryRaw<RawLoadSet[]>(Prisma.sql`
      SELECT d.date::text AS date, e.entry_index, s.set_index,
        e.value->>'training_session_id' AS training_session_id,
        e.value->>'training_exercise_id' AS training_exercise_id, s.value AS item
      FROM day_progress d
      CROSS JOIN LATERAL jsonb_array_elements(d.exercises_completed) WITH ORDINALITY e(value, entry_index)
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(e.value->'sets') = 'array'
          THEN e.value->'sets' ELSE '[]'::jsonb END) WITH ORDINALITY s(value, set_index)
      WHERE d.client_id = ${clientId} AND d.date >= ${range.from}::date
        AND d.date <= ${range.to}::date AND e.value->>'exercise_id' = ${exerciseId}
        AND (${cursor?.d ?? null}::date IS NULL OR d.date < ${cursor?.d ?? null}::date
          OR (d.date = ${cursor?.d ?? null}::date AND
            (e.entry_index > ${cursor?.i ?? null}::bigint OR
              (e.entry_index = ${cursor?.i ?? null}::bigint AND s.set_index > ${cursor?.s ?? null}::bigint))))
      ORDER BY d.date DESC, e.entry_index ASC, s.set_index ASC
      LIMIT ${limit + 1}
    `);
    const pageRows = rows.slice(0, limit);
    const page = pageRows.map((row): ExerciseLoadSet => {
      if (!row.item || typeof row.item !== 'object' || Array.isArray(row.item))
        throw new BadRequestException('Malformed historical set');
      const item = row.item as Record<string, unknown>;
      const setNumber = loadNumber(item.set_number, 'set_number');
      if (
        setNumber !== null &&
        (!Number.isSafeInteger(setNumber) || setNumber < 1)
      )
        throw new BadRequestException('Malformed historical set_number');
      const seconds = loadNumber(item.seconds, 'seconds');
      if (seconds !== null && (!Number.isSafeInteger(seconds) || seconds < 1))
        throw new BadRequestException('Malformed historical seconds');
      const storedReps = loadNumber(item.reps, 'reps');
      if (
        storedReps !== null &&
        (!Number.isSafeInteger(storedReps) || storedReps < 1)
      )
        throw new BadRequestException('Malformed historical reps');
      const reps = seconds === null ? storedReps : null;
      const weight = loadNumber(item.weight_kg, 'weight_kg');
      const rir = loadNumber(item.rir, 'rir');
      if (rir !== null && (!Number.isInteger(rir) || rir > 10))
        throw new BadRequestException('Malformed historical rir');
      const volume =
        reps !== null && weight !== null && Number.isFinite(reps * weight)
          ? reps * weight
          : null;
      return {
        date: row.date,
        training_session_id: loadString(
          row.training_session_id,
          'training_session_id',
        ),
        training_exercise_id: loadString(
          row.training_exercise_id,
          'training_exercise_id',
        ),
        set_number: setNumber,
        reps,
        seconds,
        weight_kg: weight,
        rir,
        volume,
      };
    });
    const last = pageRows.at(-1);
    const nextCursor =
      rows.length > limit && last
        ? Buffer.from(
            JSON.stringify({
              v: 1,
              c: clientId,
              e: exerciseId,
              f: range.from,
              t: range.to,
              d: last.date,
              i: safeBigintCount(last.entry_index),
              s: safeBigintCount(last.set_index),
            } satisfies LoadCursor),
          ).toString('base64url')
        : null;
    return { page, nextCursor };
  }

  /** Caller owns the transaction; authorization is always checked in its snapshot. */
  async getAuthorizedOverviewInTransaction(
    tx: Prisma.TransactionClient,
    actorId: string,
    targetId: string,
    range: TrainingProgressRange,
    options: { limit?: number; cursor?: string } = {},
  ): Promise<TrainingReadOverview> {
    await this.#assertReadAccess(tx, actorId, targetId);
    return this.#read(tx, targetId, range, options);
  }

  async #read(
    tx: Prisma.TransactionClient,
    clientId: string,
    range: TrainingProgressRange,
    options: { limit?: number; cursor?: string },
  ): Promise<TrainingReadOverview> {
    if (!validCivilDateRange(range))
      throw new BadRequestException('Invalid civil date range');
    if (!clientId) throw new BadRequestException('Client required');
    const paged = options.limit !== undefined || options.cursor !== undefined;
    const page = paged
      ? validateTrainingOverviewPage(options, clientId, range)
      : undefined;
    // First bound raw JSON work without transferring day arrays to Node.
    const [input] = await tx.$queryRaw<
      { entry_count: bigint; input_bytes: bigint }[]
    >(Prisma.sql`
      SELECT coalesce(sum(CASE WHEN jsonb_typeof(exercises_completed) = 'array'
        THEN jsonb_array_length(exercises_completed) ELSE 0 END), 0)::bigint AS entry_count,
        coalesce(sum(coalesce(octet_length(exercises_completed::text), 0) +
          coalesce(octet_length(training_sessions::text), 0)), 0)::bigint AS input_bytes
      FROM day_progress WHERE client_id = ${clientId}
        AND date >= ${range.from}::date AND date <= ${range.to}::date
    `);
    assertTrainingOverviewWorkBound({
      entryCount: input.entry_count,
      inputBytes: input.input_bytes,
      distinctExerciseCount: 0n,
    });
    // Match the production query's valid-set definition, stopping at cap + 1.
    const [distinct] = await tx.$queryRaw<
      { exercise_count: bigint }[]
    >(Prisma.sql`
      SELECT count(*) AS exercise_count FROM (
        SELECT DISTINCT e.value->>'exercise_id' AS exercise_id
        FROM day_progress d
        CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(d.exercises_completed) = 'array'
          THEN d.exercises_completed ELSE '[]'::jsonb END) e
        CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(e.value->'sets') = 'array'
          THEN e.value->'sets' ELSE '[]'::jsonb END) s
        WHERE d.client_id = ${clientId} AND d.date >= ${range.from}::date
          AND d.date <= ${range.to}::date
          AND jsonb_typeof(e.value) = 'object'
          AND jsonb_typeof(e.value->'exercise_id') = 'string'
          AND length(e.value->>'exercise_id') > 0
          AND jsonb_typeof(e.value->'sets') = 'array'
          AND jsonb_typeof(s.value) = 'object'
          AND jsonb_typeof(s.value->'set_number') = 'number'
          AND (s.value->>'set_number')::numeric BETWEEN 1 AND 9007199254740991
          AND (s.value->>'set_number')::numeric = trunc((s.value->>'set_number')::numeric)
        LIMIT ${TRAINING_OVERVIEW_MAX_DISTINCT_EXERCISES + 1}
      ) bounded
    `);
    assertTrainingOverviewWorkBound({
      entryCount: input.entry_count,
      inputBytes: input.input_bytes,
      distinctExerciseCount: distinct.exercise_count,
    });
    const exercisesRaw = await tx.$queryRaw<RawExercise[]>(
      buildTrainingOverviewExerciseQuery(clientId, range, page),
    );
    const sessionsRaw = await tx.$queryRaw<RawSessions[]>(Prisma.sql`
      WITH days AS (
        SELECT date, training_completed, training_sessions, trainings_completed FROM day_progress
        WHERE client_id = ${clientId} AND date >= ${range.from}::date AND date <= ${range.to}::date
      ), entries AS (
        SELECT d.date, e.value AS entry FROM days d
        CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(d.training_sessions) = 'array'
          THEN d.training_sessions ELSE '[]'::jsonb END) e
        WHERE jsonb_typeof(e.value) = 'object'
      ), claims AS (
        SELECT date,
          CASE WHEN jsonb_typeof(entry->'training_id') = 'string'
            AND length(entry->>'training_id') > 0 THEN entry->>'training_id' END AS training_id,
          CASE WHEN jsonb_typeof(entry->'training_session_id') = 'string'
            AND length(entry->>'training_session_id') > 0
            THEN entry->>'training_session_id' END AS session_id,
          entry->'confirmed' AS confirmed,
          (NOT (entry ? 'confirmed') OR entry->'confirmed' = 'true'::jsonb
            OR entry->'confirmed' = 'false'::jsonb) AS valid_confirmed,
          jsonb_typeof(entry->'rpe') AS rpe_type, entry->>'rpe' AS rpe_text,
          CASE WHEN jsonb_typeof(entry->'note') = 'string'
            THEN entry->>'note' END AS note,
          (entry->'note' IS NULL OR jsonb_typeof(entry->'note') IN ('string', 'null')) AS valid_note
        FROM entries
      ), checked AS (
        SELECT *,
          CASE WHEN rpe_type = 'number' THEN
            CASE WHEN rpe_text::numeric BETWEEN 1 AND 10
              AND rpe_text::numeric = trunc(rpe_text::numeric)
              THEN rpe_text::numeric END END AS rpe,
          CASE WHEN rpe_type = 'number' THEN
            rpe_text::numeric BETWEEN 1 AND 10
              AND rpe_text::numeric = trunc(rpe_text::numeric)
            ELSE rpe_type IS NULL OR rpe_type = 'null' END AS valid_rpe
        FROM claims
      ), unique_sessions AS (
        SELECT date, min(rpe) AS rpe
        FROM checked
        WHERE (training_id IS NOT NULL OR session_id IS NOT NULL)
          AND confirmed IS DISTINCT FROM 'false'::jsonb
        GROUP BY date, session_id,
          CASE WHEN session_id IS NULL THEN training_id END
        HAVING bool_and(training_id IS NOT NULL AND valid_confirmed AND valid_rpe AND valid_note)
          AND count(DISTINCT (training_id, rpe, note)) = 1
      ), legacy AS (
        SELECT DISTINCT d.date, t.training_id
        FROM days d
        CROSS JOIN LATERAL unnest(d.trainings_completed) t(training_id)
        WHERE d.training_completed = true AND length(t.training_id) > 0 AND NOT EXISTS (
          SELECT 1 FROM checked e WHERE e.date = d.date AND e.training_id = t.training_id
        )
      ), all_sessions AS (
        SELECT rpe FROM unique_sessions UNION ALL SELECT NULL::numeric FROM legacy
      )
      SELECT count(*) AS completed, sum(rpe)::text AS rpe_total, count(rpe) AS rpe_count
      FROM all_sessions
    `);
    const visibleRows = exercisesRaw.filter(
      (row): row is RawExercise & { exercise_id: string } =>
        row.exercise_id !== null,
    );
    const pageRows = page ? visibleRows.slice(0, page.limit) : visibleRows;
    const exercises: TrainingExerciseSummary[] = pageRows.map((row) => ({
      exercise_id: row.exercise_id,
      exercise_name: row.exercise_name,
      sets: safeBigintCount(row.sets),
      max_reps: row.max_reps,
      max_seconds: row.max_seconds,
      volume: row.volume,
      mean_rir: row.mean_rir,
      pr:
        row.pr_weight !== null &&
        row.pr_reps !== null &&
        row.pr_date !== null &&
        row.pr_set !== null
          ? {
              weight_kg: row.pr_weight,
              reps: row.pr_reps,
              date: row.pr_date,
              training_session_id: row.pr_session,
              set_number: row.pr_set,
            }
          : null,
    }));
    const session = sessionsRaw[0];
    const global = exercisesRaw[0];
    const rirCount = safeBigintCount(global?.overall_rir_count ?? 0n);
    const rpeCount = safeBigintCount(session.rpe_count);
    const rirTotal = Number(global?.overall_rir_total ?? 0);
    const result: TrainingReadOverview = {
      indicators: {
        trainings_completed: safeBigintCount(session.completed),
        volume: global?.overall_volume ?? null,
        mean_rir:
          rirCount && Number.isFinite(rirTotal) ? rirTotal / rirCount : null,
        mean_rpe:
          rpeCount && Number.isFinite(Number(session.rpe_total))
            ? Number(session.rpe_total) / rpeCount
            : null,
      },
      exercises,
      ...(page
        ? {
            next_cursor:
              visibleRows.length > page.limit && exercises.length
                ? encodeTrainingOverviewCursor(
                    clientId,
                    range,
                    exercises[exercises.length - 1].exercise_id,
                  )
                : null,
          }
        : {}),
    };
    assertTrainingOverviewResponseBound(result);
    return result;
  }
}
