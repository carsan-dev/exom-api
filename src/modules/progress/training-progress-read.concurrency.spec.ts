import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { assertTestDatabase } from '../../../scripts/test-database.cjs';
import {
  TrainingProgressReadService,
  TrainingReadOverview,
  safeBigintCount,
} from './training-progress-read.service';

describe('training progress read API boundary', () => {
  it('does not expose unauthenticated read entry points', () => {
    const assertNoBypass = (reader: TrainingProgressReadService) => {
      // @ts-expect-error Unauthenticated overview reads must be private.
      void reader.getOverview;
      // @ts-expect-error Unauthenticated load history reads must be private.
      void reader.getExerciseLoadHistory;
      // @ts-expect-error Raw transaction reads must be private.
      void reader.read;
      // @ts-expect-error Raw transaction history reads must be private.
      void reader.readExerciseLoadHistory;
    };
    expect(assertNoBypass).toBeDefined();
    const exposed = Object.getOwnPropertyNames(
      TrainingProgressReadService.prototype,
    );
    expect(exposed).not.toContain('getOverview');
    expect(exposed).not.toContain('getExerciseLoadHistory');
    expect(exposed).not.toContain('read');
    expect(exposed).not.toContain('readExerciseLoadHistory');
  });
});

describe('safe PostgreSQL count conversion', () => {
  it('accepts exact boundary counts and refuses inaccurate integers', () => {
    expect(safeBigintCount(0n)).toBe(0);
    expect(safeBigintCount(BigInt(Number.MAX_SAFE_INTEGER))).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(() => safeBigintCount(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toThrow(
      RangeError,
    );
    expect(() => safeBigintCount(-1n)).toThrow(RangeError);
  });
});

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite('training progress bounded PostgreSQL read model', () => {
  let pool: Pool;
  let db: PrismaClient;
  let reader: TrainingProgressReadService;
  const prefix = `p3-read-${randomUUID()}`;
  const ids: string[] = [];
  const syntheticTrainingIds: string[] = [];
  async function client() {
    const id = `${prefix}-${ids.length}`;
    await db.user.create({
      data: {
        id,
        email: `${id}@example.test`,
        firebase_uid: id,
        role: 'CLIENT',
      },
    });
    ids.push(id);
    return id;
  }
  async function createSyntheticTrainings(trainingIds: string[]) {
    await db.training.createMany({
      data: trainingIds.map((id, position) => ({
        id,
        name: `Multi-assigned training ${position}`,
        type: 'STRENGTH',
        tags: [],
      })),
    });
    syntheticTrainingIds.push(...trainingIds);
  }
  const date = (day: string) => new Date(`${day}T00:00:00.000Z`);
  const range = { from: '2026-09-23', to: '2026-09-24' };
  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await assertTestDatabase(pool);
    db = new PrismaClient({ adapter: new PrismaPg(pool) });
    reader = new TrainingProgressReadService(db);
  });
  afterAll(async () => {
    if (db && ids.length)
      await db.user.deleteMany({ where: { id: { in: ids } } });
    if (db && syntheticTrainingIds.length)
      await db.training.deleteMany({
        where: { id: { in: syntheticTrainingIds } },
      });
    await db?.$disconnect();
    await pool?.end();
  });

  it('does not register a failed fixture creation for teardown', async () => {
    const before = [...ids];
    const spy = jest
      .spyOn(db.user, 'create')
      .mockRejectedValue(new Error('simulated creation failure'));
    try {
      await expect(client()).rejects.toThrow('simulated creation failure');
      expect(ids).toEqual(before);
    } finally {
      spy.mockRestore();
    }
  });

  it('does not register failed synthetic training creation for teardown', async () => {
    const before = [...syntheticTrainingIds];
    const spy = jest
      .spyOn(db.training, 'createMany')
      .mockRejectedValue(new Error('simulated training creation failure'));
    try {
      await expect(
        createSyntheticTrainings([`${prefix}-failed-training`]),
      ).rejects.toThrow('simulated training creation failure');
      expect(syntheticTrainingIds).toEqual(before);
    } finally {
      spy.mockRestore();
    }
  });

  it('accepts at most 366 inclusive civil dates per authorized training read', async () => {
    const owner = await client();
    const leapYear = { from: '2024-01-01', to: '2024-12-31' };
    const followingYear = { from: '2025-01-01', to: '2025-12-31' };
    const tooLong = { from: '2024-01-01', to: '2025-01-01' };
    const reads = (period: typeof leapYear) => [
      () => reader.getAuthorizedOverview(owner, owner, period),
      () =>
        reader.getAuthorizedExerciseLoadHistory(owner, owner, 'lift', period),
      () => reader.getAuthorizedSessionList(owner, owner, period),
    ];

    for (const period of [leapYear, followingYear]) {
      for (const read of reads(period)) {
        await expect(read()).resolves.toBeDefined();
      }
    }
    for (const read of reads(tooLong)) {
      await expect(read()).rejects.toMatchObject({ status: 400 });
    }
  });

  it('bounds a filtered page with 1000 named historical exercises', async () => {
    const owner = await client();
    const entries = Array.from({ length: 1000 }, (_, i) => ({
      exercise_id: `lift-${String(i).padStart(4, '0')}`,
      training_session_id: 's',
      training_exercise_id: `occurrence-${i}`,
      sets: [{ set_number: 1, weight_kg: 10, reps: 2 }],
    }));
    await db.dayProgress.create({
      data: {
        client_id: owner,
        date: date(range.to),
        exercises_completed: entries,
        training_sessions: [
          { training_id: 'training', training_session_id: 's' },
        ],
      },
    });
    await db.trainingDaySnapshot.create({
      data: {
        client_id: owner,
        date: date(range.to),
        training_id: 'training',
        version: 1,
        payload: {
          exercises: entries.map((entry, i) => ({
            id: entry.training_exercise_id,
            exercise_id: entry.exercise_id,
            exercise: { name: `Historical lift ${i}` },
          })),
        },
      },
    });
    const started = Date.now();
    const options = {
      limit: 20,
      identification: 'identified' as const,
      search: 'lift 99',
    };
    const result = await reader.getAuthorizedOverview(
      owner,
      owner,
      range,
      options,
    );
    expect(result.exercises).toHaveLength(11);
    expect(result.next_cursor).toBeNull();
    expect(result.indicators.volume).toBe(20000);
    expect(Date.now() - started).toBeLessThan(30000);
    console.log(
      `Filtered 1000-name overview: ${Date.now() - started}ms, ${Buffer.byteLength(JSON.stringify(result))} bytes`,
    );
  }, 35000);

  it('searches identified historical names before pagination without filtering global indicators', async () => {
    const owner = await client();
    const entries = Array.from({ length: 105 }, (_, index) => ({
      exercise_id: `lift-${String(index).padStart(3, '0')}`,
      training_session_id: 's',
      training_exercise_id: `occurrence-${index}`,
      sets: [{ set_number: 1, weight_kg: 10, reps: 2, rir: 2 }],
    }));
    await db.dayProgress.create({
      data: {
        client_id: owner,
        date: date(range.to),
        exercises_completed: entries,
        training_sessions: [
          { training_id: 'training', training_session_id: 's', rpe: 7 },
        ],
      },
    });
    await db.trainingDaySnapshot.create({
      data: {
        client_id: owner,
        date: date(range.to),
        training_id: 'training',
        version: 1,
        payload: {
          exercises: entries.slice(100).map((entry, index) => ({
            id: entry.training_exercise_id,
            exercise_id: entry.exercise_id,
            exercise: {
              name:
                index === 4
                  ? '   '
                  : index === 3
                    ? 'Remo 100%_literal'
                    : 'Remo histórico',
            },
          })),
        },
      },
    });
    const before = await db.dayProgress.findMany({
      where: { client_id: owner },
    });
    const baseline = await reader.getAuthorizedOverview(owner, owner, range, {
      limit: 100,
    });
    const options = {
      limit: 2,
      identification: 'identified' as const,
      search: '  REMO  ',
    };
    const first = await reader.getAuthorizedOverview(
      owner,
      owner,
      range,
      options,
    );
    expect(first.exercises.map((item) => item.exercise_id)).toEqual([
      'lift-100',
      'lift-101',
    ]);
    expect(first.indicators).toEqual(baseline.indicators);
    expect(first.next_cursor).toEqual(expect.any(String));
    const second = await reader.getAuthorizedOverview(owner, owner, range, {
      ...options,
      cursor: first.next_cursor!,
    });
    expect(second.exercises.map((item) => item.exercise_id)).toEqual([
      'lift-102',
      'lift-103',
    ]);
    expect(second.next_cursor).toBeNull();
    expect(second.indicators).toEqual(baseline.indicators);
    const empty = await reader.getAuthorizedOverview(owner, owner, range, {
      ...options,
      search: 'missing',
    });
    expect(empty.exercises).toEqual([]);
    expect(empty.indicators).toEqual(baseline.indicators);
    const literal = await reader.getAuthorizedOverview(owner, owner, range, {
      ...options,
      search: '%_',
    });
    expect(literal.exercises.map((item) => item.exercise_id)).toEqual([
      'lift-103',
    ]);
    await expect(
      reader.getAuthorizedOverview(owner, owner, range, {
        ...options,
        search: 'other',
        cursor: first.next_cursor!,
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      reader.getAuthorizedOverview(await client(), owner, range, options),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      await db.dayProgress.findMany({ where: { client_id: owner } }),
    ).toEqual(before);
  });

  it('authorizes both read models from canonical actor state and active assignments before reading progress', async () => {
    const owner = await client();
    const stranger = await client();
    const coach = await client();
    const superAdmin = await client();
    const targetAdmin = await client();
    await db.user.update({ where: { id: coach }, data: { role: 'ADMIN' } });
    await db.user.update({
      where: { id: superAdmin },
      data: { role: 'SUPER_ADMIN' },
    });
    await db.user.update({
      where: { id: targetAdmin },
      data: { role: 'ADMIN' },
    });
    await db.dayProgress.create({
      data: {
        client_id: owner,
        date: date('2026-09-24'),
        training_sessions: [
          { training_id: 'private', training_session_id: 'one', rpe: 8 },
        ],
        exercises_completed: [
          {
            exercise_id: 'private',
            sets: [{ set_number: 1, reps: 2, weight_kg: 50 }],
          },
        ],
      },
    });
    const period = { from: '2026-09-24', to: '2026-09-24' };
    const overview = (actor: string, target = owner) =>
      reader.getAuthorizedOverview(actor, target, period);
    const history = (actor: string, target = owner) =>
      reader.getAuthorizedExerciseLoadHistory(actor, target, 'private', period);
    const permitted = async (actor: string) => {
      expect((await overview(actor)).indicators.trainings_completed).toBe(1);
      expect((await history(actor)).page).toMatchObject([{ weight_kg: 50 }]);
    };
    const denied = async (actor: string, target = owner) => {
      await expect(overview(actor, target)).rejects.toMatchObject({
        status: 403,
      });
      await expect(history(actor, target)).rejects.toMatchObject({
        status: 403,
      });
    };
    await permitted(owner);
    await denied(stranger);
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      await expect(
        reader.getAuthorizedOverviewInTransaction(tx, stranger, owner, period),
      ).rejects.toMatchObject({ status: 403 });
    });
    await denied(coach);
    await db.adminClientAssignment.create({
      data: { admin_id: coach, client_id: owner },
    });
    await permitted(coach);
    await db.adminClientAssignment.update({
      where: { admin_id_client_id: { admin_id: coach, client_id: owner } },
      data: { is_active: false },
    });
    await denied(coach);
    await permitted(superAdmin);
    await denied(superAdmin, targetAdmin);
    await denied('missing-actor');
    // A malformed private history would raise 400 if either reader ran before authorization.
    const corrupt = await client();
    await db.dayProgress.create({
      data: {
        client_id: corrupt,
        date: date('2026-09-24'),
        exercises_completed: [{ exercise_id: 'private', sets: 'malformed' }],
      },
    });
    await denied(stranger, corrupt);
    for (const patch of [
      { is_active: false },
      { is_locked: true },
      { is_archived: true },
    ]) {
      await db.user.update({
        where: { id: coach },
        data: {
          is_active: true,
          is_locked: false,
          is_archived: false,
          role: 'SUPER_ADMIN',
          ...patch,
        },
      });
      await denied(coach);
    }
    await db.user.update({
      where: { id: coach },
      data: {
        is_active: true,
        is_locked: false,
        is_archived: false,
        role: 'CLIENT',
      },
    });
    await denied(coach);
    for (const patch of [
      { is_active: false },
      { is_locked: true },
      { is_archived: true },
    ]) {
      await db.user.update({
        where: { id: owner },
        data: {
          is_active: true,
          is_locked: false,
          is_archived: false,
          ...patch,
        },
      });
      await denied(superAdmin);
    }
  });

  it('pages only the overview legacy contribution without disclosing historical identifiers', async () => {
    const owner = await client();
    const other = await client();
    const coach = await client();
    const chief = await client();
    await db.user.update({ where: { id: coach }, data: { role: 'ADMIN' } });
    await db.user.update({
      where: { id: chief },
      data: { role: 'SUPER_ADMIN' },
    });
    const rows = [
      {
        day: '2026-09-24',
        completed: true,
        ids: [
          'z-secret',
          'a-secret',
          'a-secret',
          'c-secret',
          'd-secret',
          '',
          'claimed-secret',
          'draft-secret',
          'contradicted-secret',
        ],
        claims: [
          {
            training_id: 'claimed-secret',
            training_session_id: 'confirmed',
            rpe: 5,
          },
          {
            training_id: 'draft-secret',
            training_session_id: 'draft',
            confirmed: false,
          },
          {
            training_id: 'contradicted-secret',
            training_session_id: 'same',
            rpe: 5,
          },
          {
            training_id: 'contradicted-secret',
            training_session_id: 'same',
            rpe: 9,
          },
        ],
      },
      {
        day: '2026-09-23',
        completed: true,
        ids: ['m-secret', 'b-secret', 'm-secret'],
        claims: 'malformed',
      },
      {
        day: '2026-09-22',
        completed: false,
        ids: ['ignored-secret'],
        claims: [],
      },
    ];
    for (const row of rows) {
      await db.dayProgress.create({
        data: {
          client_id: owner,
          date: date(row.day),
          training_completed: row.completed,
          trainings_completed: row.ids,
          training_sessions: row.claims,
        },
      });
    }
    await db.dayProgress.create({
      data: {
        client_id: other,
        date: date('2026-09-24'),
        training_completed: true,
        trainings_completed: ['intruder-secret'],
      },
    });
    const period = { from: '2026-09-22', to: '2026-09-24' };
    const read = (
      actor: string,
      target = owner,
      window = period,
      options: { limit?: number; cursor?: string } = {},
    ) =>
      reader.getAuthorizedLegacyTrainingRecords(actor, target, window, options);
    await expect(read(owner)).rejects.toMatchObject({ status: 403 });
    await expect(read(other)).rejects.toMatchObject({ status: 403 });
    await expect(read(coach)).rejects.toMatchObject({ status: 403 });
    await db.adminClientAssignment.create({
      data: { admin_id: coach, client_id: owner },
    });
    const first = await read(coach, owner, period, { limit: 2 });
    expect(first.page).toEqual([
      { date: '2026-09-24', record_index: 1, kind: 'uncertain_legacy' },
      { date: '2026-09-24', record_index: 2, kind: 'uncertain_legacy' },
    ]);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(
      JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString('utf8')),
    ).toEqual({
      v: 1,
      c: owner,
      f: period.from,
      t: period.to,
      d: '2026-09-24',
      i: 2,
    });
    const second = await read(coach, owner, period, {
      limit: 2,
      cursor: first.nextCursor!,
    });
    const third = await read(chief, owner, period, {
      limit: 2,
      cursor: second.nextCursor!,
    });
    expect([...first.page, ...second.page, ...third.page]).toEqual([
      ...first.page,
      { date: '2026-09-24', record_index: 3, kind: 'uncertain_legacy' },
      { date: '2026-09-24', record_index: 4, kind: 'uncertain_legacy' },
      { date: '2026-09-23', record_index: 1, kind: 'uncertain_legacy' },
      { date: '2026-09-23', record_index: 2, kind: 'uncertain_legacy' },
    ]);
    expect(third.nextCursor).toBeNull();
    const overview = await reader.getAuthorizedOverview(owner, owner, period);
    // One valid explicit session plus six distinct legacy records.
    expect(overview.indicators.trainings_completed).toBe(7);
    expect(first.page.length + second.page.length + third.page.length).toBe(
      overview.indicators.trainings_completed - 1,
    );
    const serialized = JSON.stringify([first, second, third]);
    for (const secret of ['secret', 'intruder', 'confirmed', 'draft', 'same']) {
      expect(serialized).not.toContain(secret);
      expect(
        Buffer.from(first.nextCursor!, 'base64url').toString('utf8'),
      ).not.toContain(secret);
    }
    expect(
      JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString('utf8')),
    ).toEqual({
      v: 1,
      c: owner,
      f: period.from,
      t: period.to,
      d: '2026-09-24',
      i: 2,
    });
    await expect(
      read(chief, other, period, { cursor: first.nextCursor! }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      read(
        chief,
        owner,
        { from: '2026-09-23', to: period.to },
        { cursor: first.nextCursor! },
      ),
    ).rejects.toMatchObject({ status: 400 });
    for (const cursor of [
      'bad',
      `${first.nextCursor!}=`,
      Buffer.from(
        JSON.stringify({
          v: 1,
          c: owner,
          f: period.from,
          t: period.to,
          d: '2026-09-24',
          i: 0,
        }),
      ).toString('base64url'),
    ]) {
      await expect(
        read(chief, owner, period, { cursor }),
      ).rejects.toMatchObject({ status: 400 });
    }
    for (const limit of [0, 101, 1.5])
      await expect(read(chief, owner, period, { limit })).rejects.toMatchObject(
        { status: 400 },
      );
    await expect(
      read(chief, owner, { from: '2024-01-01', to: '2025-01-01' }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      read(chief, owner, { from: '2026-02-30', to: period.to }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      read(chief, owner, { from: '2024-01-01', to: '2024-12-31' }),
    ).resolves.toEqual({ page: [], nextCursor: null });
    await db.adminClientAssignment.update({
      where: { admin_id_client_id: { admin_id: coach, client_id: owner } },
      data: { is_active: false },
    });
    await expect(read(coach)).rejects.toMatchObject({ status: 403 });
  });

  it('counts historical IDs only on completed days, without changing the historical rows', async () => {
    const id = await client();
    const cases = [
      {
        day: '2026-09-20',
        completed: false,
        ids: ['A'],
        sessions: [],
        expected: 0,
      },
      {
        day: '2026-09-21',
        completed: true,
        ids: ['A'],
        sessions: [],
        expected: 1,
      },
      {
        day: '2026-09-22',
        completed: false,
        ids: ['A', 'B'],
        sessions: [
          { training_id: 'B', training_session_id: 'confirmed-B', rpe: 7 },
        ],
        expected: 1,
      },
      {
        day: '2026-09-23',
        completed: true,
        ids: ['B', 'B'],
        sessions: [
          { training_id: 'B', training_session_id: 'confirmed-B', rpe: 8 },
        ],
        expected: 1,
      },
    ];
    for (const row of cases) {
      await db.dayProgress.create({
        data: {
          client_id: id,
          date: date(row.day),
          training_completed: row.completed,
          trainings_completed: row.ids,
          training_sessions: row.sessions,
        },
      });
    }
    const before = await db.dayProgress.findMany({
      where: { client_id: id },
      orderBy: { date: 'asc' },
    });
    for (const row of cases) {
      const result = await reader.getAuthorizedOverview(id, id, {
        from: row.day,
        to: row.day,
      });
      expect(result.indicators.trainings_completed).toBe(row.expected);
    }
    expect(
      (
        await reader.getAuthorizedOverview(id, id, {
          from: '2026-09-20',
          to: '2026-09-23',
        })
      ).indicators,
    ).toMatchObject({ trainings_completed: 3, mean_rpe: 7.5 });
    expect(
      await db.dayProgress.findMany({
        where: { client_id: id },
        orderBy: { date: 'asc' },
      }),
    ).toEqual(before);
  });

  it('aggregates partial, legacy and independent explicit sessions without fetching JSON arrays', async () => {
    const id = await client();
    await db.dayProgress.createMany({
      data: [
        {
          client_id: id,
          date: date('2026-09-23'),
          training_completed: true,
          trainings_completed: ['legacy', 'legacy'],
          notes: 'Daily note must not be attributed',
          exercises_completed: [
            {
              exercise_id: 'squat',
              training_session_id: 'a',
              training_exercise_id: 'assignment-a',
              sets: [
                { set_number: 1, weight_kg: 0, reps: 5, rir: 0 },
                { set_number: 2, weight_kg: 80, reps: 3, rir: 2 },
                {
                  set_number: 3,
                  weight_kg: 100,
                  seconds: 45,
                  reps: 999,
                  rir: 4,
                },
                { set_number: 4, weight_kg: 'bad', reps: 5, rir: '0' },
              ],
            },
            { exercise_id: 'plank', sets: [{ set_number: 1, seconds: 30 }] },
          ],
        },
        {
          client_id: id,
          date: date('2026-09-24'),
          trainings_completed: ['squat-training'],
          training_sessions: [
            {
              training_id: 'squat-training',
              training_session_id: 'a',
              rpe: 6,
              note: 'a',
            },
            {
              training_id: 'squat-training',
              training_session_id: 'b',
              rpe: 8,
              note: 'b',
            },
            {
              training_id: 'squat-training',
              training_session_id: 'b',
              rpe: 8,
              note: 'b',
            },
            {
              training_id: 'draft',
              training_session_id: 'draft',
              rpe: 10,
              confirmed: false,
            },
          ],
          exercises_completed: [
            {
              exercise_id: 'squat',
              training_session_id: 'b',
              sets: [
                { set_number: 1, weight_kg: 80, reps: 4, rir: 0 },
                { set_number: 2, weight_kg: 80, reps: 4, rir: 0 },
              ],
            },
          ],
        },
      ],
    });
    const other = await client();
    await db.dayProgress.create({
      data: {
        client_id: other,
        date: date('2026-09-24'),
        trainings_completed: ['intruder'],
        exercises_completed: [
          {
            exercise_id: 'intruder',
            sets: [{ set_number: 1, weight_kg: 999, reps: 9 }],
          },
        ],
      },
    });
    const result = await reader.getAuthorizedOverview(id, id, range);
    expect(result.indicators).toMatchObject({
      trainings_completed: 3,
      volume: 880,
      mean_rir: 1.2,
      mean_rpe: 7,
    });
    expect(result.exercises).toEqual([
      expect.objectContaining({
        exercise_id: 'plank',
        volume: null,
        sets: 1,
        max_seconds: 30,
        pr: null,
      }),
      expect.objectContaining({
        exercise_id: 'squat',
        volume: 880,
        sets: 6,
        mean_rir: 1.2,
      }),
    ]);
    expect(result.exercises[1].pr).toMatchObject({
      weight_kg: 80,
      reps: 4,
      date: '2026-09-24',
      training_session_id: 'b',
    });
    expect(JSON.stringify(result)).not.toContain('Daily note');
    expect(JSON.stringify(result)).not.toContain('intruder');
    expect(
      (
        await reader.getAuthorizedOverview(id, id, {
          from: '2026-09-24',
          to: '2026-09-24',
        })
      ).indicators.trainings_completed,
    ).toBe(2);
  });

  it('pages opted-in overview exercises without shrinking window indicators or leaking cursors', async () => {
    const owner = await client();
    const other = await client();
    const day = '2026-09-24';
    const period = { from: day, to: day };
    await db.dayProgress.create({
      data: {
        client_id: owner,
        date: date(day),
        training_sessions: [
          { training_id: 'training', training_session_id: 'session', rpe: 8 },
        ],
        exercises_completed: [
          {
            exercise_id: 'z',
            sets: [{ set_number: 1, reps: 4, weight_kg: 30, rir: 4 }],
          },
          {
            exercise_id: 'a',
            sets: [{ set_number: 1, reps: 2, weight_kg: 10, rir: 0 }],
          },
          {
            exercise_id: 'm',
            sets: [{ set_number: 1, reps: 3, weight_kg: 20, rir: 2 }],
          },
        ],
      },
    });
    const legacy = await reader.getAuthorizedOverview(owner, owner, period);
    expect(legacy.exercises.map((exercise) => exercise.exercise_id)).toEqual([
      'a',
      'm',
      'z',
    ]);
    expect(legacy).not.toHaveProperty('next_cursor');
    const indicators = {
      volume: 200,
      mean_rir: 2,
      trainings_completed: 1,
      mean_rpe: 8,
    };
    expect(legacy.indicators).toMatchObject(indicators);

    // Reflect.apply keeps this RED behavioral while the production method has only three typed arguments.
    const overview = (
      actor: string,
      target: string,
      window: typeof period,
      options: { limit?: number; cursor?: string },
    ): Promise<unknown> => {
      const method: unknown = reader.getAuthorizedOverview.bind(reader);
      if (typeof method !== 'function')
        throw new Error('Overview read unavailable');
      const result: unknown = Reflect.apply(method, reader, [
        actor,
        target,
        window,
        options,
      ]);
      return Promise.resolve(result);
    };
    const first: unknown = await overview(owner, owner, period, { limit: 2 });
    expect(first).toMatchObject({
      indicators,
      exercises: [
        { exercise_id: 'a', volume: 20, mean_rir: 0 },
        { exercise_id: 'm', volume: 60, mean_rir: 2 },
      ],
    });
    expect(first).toHaveProperty('next_cursor', expect.any(String));
    if (
      typeof first !== 'object' ||
      first === null ||
      !('next_cursor' in first) ||
      typeof first.next_cursor !== 'string'
    ) {
      throw new Error('Expected an overview page cursor');
    }
    const cursor = first.next_cursor;
    const second: unknown = await overview(owner, owner, period, {
      limit: 2,
      cursor,
    });
    expect(second).toMatchObject({
      indicators,
      exercises: [{ exercise_id: 'z', volume: 120, mean_rir: 4 }],
      next_cursor: null,
    });
    await expect(
      overview(other, other, period, { limit: 2, cursor }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      overview(
        owner,
        owner,
        { from: '2026-09-23', to: day },
        { limit: 2, cursor },
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      overview(other, owner, period, { limit: 2, cursor }),
    ).rejects.toMatchObject({ status: 403 });
    // An invalid range would be 400 if progress validation preceded authorization.
    await expect(
      overview(other, owner, { from: '2026-02-30', to: day }, { limit: 2 }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('rejects 10,001 distinct valid exercises before returning either legacy or paged overview', async () => {
    const owner = await client();
    const day = '2026-09-24';
    const period = { from: day, to: day };
    const entries = Array.from({ length: 10_001 }, (_, index) => ({
      exercise_id: `exercise-${String(index).padStart(5, '0')}`,
      sets: [{ set_number: 1, reps: 2, weight_kg: 1 }],
    }));
    expect(Buffer.byteLength(JSON.stringify(entries), 'utf8')).toBeLessThan(
      6 * 1024 * 1024,
    );
    await db.dayProgress.create({
      data: {
        client_id: owner,
        date: date(day),
        exercises_completed: entries,
      },
    });
    for (const options of [undefined, { limit: 100 }]) {
      await expect(
        reader.getAuthorizedOverview(owner, owner, period, options),
      ).rejects.toMatchObject({
        status: 413,
        response: { code: 'TRAINING_OVERVIEW_LIMIT_EXCEEDED' },
      });
    }
  }, 120_000);

  it('bounds setless completed exercise identities before the overview query', async () => {
    const owner = await client();
    const day = '2026-09-24';
    const period = { from: day, to: day };
    const entries = Array.from({ length: 10_001 }, (_, index) => ({
      exercise_id: `setless-${String(index).padStart(5, '0')}`,
      training_session_id: 'performed',
      training_exercise_id: `occurrence-${index}`,
    }));
    expect(Buffer.byteLength(JSON.stringify(entries), 'utf8')).toBeLessThan(
      6 * 1024 * 1024,
    );
    await db.dayProgress.create({
      data: {
        client_id: owner,
        date: date(day),
        training_sessions: [
          { training_id: 'training', training_session_id: 'performed' },
        ],
        exercises_completed: entries,
      },
    });

    await expect(
      reader.getAuthorizedOverview(owner, owner, period, {
        identification: 'identified',
        limit: 20,
      }),
    ).rejects.toMatchObject({
      status: 413,
      response: { code: 'TRAINING_OVERVIEW_LIMIT_EXCEEDED' },
    });
  }, 120_000);

  it('reports unweighted reps and timed seconds with names only from the confirmed session snapshot', async () => {
    const owner = await client();
    const day = '2026-09-24';
    await db.dayProgress.create({
      data: {
        client_id: owner,
        date: date(day),
        training_sessions: [
          { training_id: 'prescription', training_session_id: 'performed' },
          { training_id: 'without-snapshot', training_session_id: 'legacy' },
        ],
        exercises_completed: [
          {
            exercise_id: 'bodyweight',
            training_exercise_id: 'bodyweight-occurrence',
            training_session_id: 'performed',
            sets: [
              { set_number: 1, reps: 8 },
              { set_number: 2, reps: 10 },
            ],
          },
          {
            exercise_id: 'timer',
            training_exercise_id: 'timer-occurrence',
            training_session_id: 'performed',
            sets: [{ set_number: 1, seconds: 45 }],
          },
          {
            exercise_id: 'legacy',
            training_exercise_id: 'legacy-occurrence',
            training_session_id: 'legacy',
            sets: [{ set_number: 1, reps: 6 }],
          },
        ],
      },
    });
    // The same occurrence in an unrelated training must not supply a name.
    await db.trainingDaySnapshot.createMany({
      data: [
        {
          client_id: owner,
          date: date(day),
          training_id: 'prescription',
          version: 1,
          payload: {
            exercises: [
              {
                id: 'bodyweight-occurrence',
                exercise_id: 'bodyweight',
                exercise: { name: 'Historical bodyweight' },
              },
              {
                id: 'timer-occurrence',
                exercise_id: 'timer',
                exercise: { name: 'Historical timer' },
              },
            ],
          },
        },
        {
          client_id: owner,
          date: date(day),
          training_id: 'unrelated',
          version: 1,
          payload: {
            exercises: [
              {
                id: 'legacy-occurrence',
                exercise_id: 'legacy',
                exercise: { name: 'Wrong training name' },
              },
            ],
          },
        },
      ],
    });
    // No live Exercise rows exist for these IDs; a catalog lookup cannot pass.
    const overview = await reader.getAuthorizedOverview(owner, owner, {
      from: day,
      to: day,
    });
    expect(overview.exercises).toEqual([
      expect.objectContaining({
        exercise_id: 'bodyweight',
        exercise_name: 'Historical bodyweight',
        sets: 2,
        max_reps: 10,
        max_seconds: null,
        volume: null,
      }),
      expect.objectContaining({
        exercise_id: 'legacy',
        exercise_name: null,
        max_reps: 6,
      }),
      expect.objectContaining({
        exercise_id: 'timer',
        exercise_name: 'Historical timer',
        max_reps: null,
        max_seconds: 45,
        volume: null,
      }),
    ]);
  });

  it('keeps the latest historically evidenced name when a later completion has no sets', async () => {
    const owner = await client();
    const otherOwner = await client();
    const firstDay = '2026-09-23';
    const secondDay = '2026-09-24';
    const exerciseId = 'stable-running';
    const occurrenceId = 'running-occurrence';
    await db.dayProgress.createMany({
      data: [
        {
          client_id: owner,
          date: date(firstDay),
          training_sessions: [
            {
              training_id: 'named-training',
              training_session_id: 'named-session',
            },
          ],
          exercises_completed: [
            {
              exercise_id: exerciseId,
              training_exercise_id: occurrenceId,
              training_session_id: 'named-session',
              sets: [{ set_number: 1, weight_kg: 20, reps: 8 }],
            },
          ],
        },
        {
          client_id: owner,
          date: date(secondDay),
          training_sessions: [
            {
              training_id: 'legacy-training',
              training_session_id: 'legacy-session',
            },
          ],
          exercises_completed: [
            {
              exercise_id: exerciseId,
              training_exercise_id: occurrenceId,
              training_session_id: 'legacy-session',
            },
          ],
        },
      ],
    });
    await db.trainingDaySnapshot.createMany({
      data: [
        {
          client_id: owner,
          date: date(firstDay),
          training_id: 'named-training',
          version: 1,
          payload: {
            exercises: [
              {
                id: occurrenceId,
                exercise_id: exerciseId,
                exercise: { name: 'Contract running' },
              },
            ],
          },
        },
        {
          client_id: otherOwner,
          date: date(secondDay),
          training_id: 'legacy-training',
          version: 1,
          payload: {
            exercises: [
              {
                id: occurrenceId,
                exercise_id: exerciseId,
                exercise: { name: 'Other owner running' },
              },
            ],
          },
        },
      ],
    });

    const latestOnly = await reader.getAuthorizedOverview(owner, owner, {
      from: secondDay,
      to: secondDay,
    });
    expect(latestOnly.exercises).toEqual([
      expect.objectContaining({
        exercise_id: exerciseId,
        exercise_name: null,
        sets: 0,
        max_reps: null,
        volume: null,
      }),
    ]);
    const overview = await reader.getAuthorizedOverview(owner, owner, {
      from: firstDay,
      to: secondDay,
    });
    expect(overview.exercises).toEqual([
      expect.objectContaining({
        exercise_id: exerciseId,
        exercise_name: 'Contract running',
        sets: 1,
        max_reps: 8,
        volume: 160,
      }),
    ]);
    expect(overview.indicators).toMatchObject({
      trainings_completed: 2,
      volume: 160,
    });
  });

  it('includes completed exercises without recorded sets in a multi-assigned day', async () => {
    const owner = await client();
    const day = '2026-09-24';
    const period = { from: day, to: day };
    const entries = [
      {
        exercise_id: 'pull-up',
        training_exercise_id: 'pull-up-occurrence',
        training_session_id: 'performed',
        sets: [{ set_number: 1, reps: 8 }],
      },
      {
        exercise_id: 'squat',
        training_exercise_id: 'squat-occurrence',
        training_session_id: 'performed',
      },
      {
        exercise_id: 'lunge',
        training_exercise_id: 'lunge-occurrence',
        training_session_id: 'performed',
        sets: [],
      },
    ];
    const trainingIds = [0, 1, 2].map(
      (position) => `${prefix}-multi-assigned-training-${position}`,
    );
    await createSyntheticTrainings(trainingIds);
    const assignment = await db.planAssignment.create({
      data: {
        client_id: owner,
        date: date(day),
        trainings: {
          create: trainingIds.map((training_id, position) => ({
            training_id,
            position,
          })),
        },
      },
    });
    const links = await db.planAssignmentTraining.findMany({
      where: { assignment_id: assignment.id },
      orderBy: { position: 'asc' },
      select: { training_id: true, position: true },
    });
    expect(links).toEqual(
      trainingIds.map((training_id, position) => ({ training_id, position })),
    );
    await db.dayProgress.create({
      data: {
        client_id: owner,
        date: date(day),
        training_sessions: [
          {
            training_id: trainingIds[0],
            training_session_id: 'performed',
          },
        ],
        exercises_completed: entries,
      },
    });
    // Three assigned trainings share the date; only the first has a confirmed session.
    await db.trainingDaySnapshot.createMany({
      data: [
        {
          client_id: owner,
          date: date(day),
          training_id: trainingIds[0],
          version: 1,
          payload: {
            exercises: [
              {
                id: 'pull-up-occurrence',
                exercise_id: 'pull-up',
                exercise: { name: 'Pull-up' },
              },
              {
                id: 'squat-occurrence',
                exercise_id: 'squat',
                exercise: { name: 'Squat' },
              },
              {
                id: 'lunge-occurrence',
                exercise_id: 'lunge',
                exercise: { name: 'Lunge' },
              },
            ],
          },
        },
        ...trainingIds.slice(1).map((trainingId) => ({
          client_id: owner,
          date: date(day),
          training_id: trainingId,
          version: 1,
          payload: { exercises: [] },
        })),
      ],
    });
    const stored = await db.dayProgress.findUniqueOrThrow({
      where: { client_id_date: { client_id: owner, date: date(day) } },
    });
    expect(stored.exercises_completed).toEqual(entries);
    expect(stored.training_sessions).toEqual([
      { training_id: trainingIds[0], training_session_id: 'performed' },
    ]);

    const overview = await reader.getAuthorizedOverview(owner, owner, period);
    expect(overview.exercises).toEqual([
      expect.objectContaining({
        exercise_id: 'lunge',
        exercise_name: 'Lunge',
        sets: 0,
        max_reps: null,
        max_seconds: null,
        volume: null,
        mean_rir: null,
        pr: null,
      }),
      expect.objectContaining({
        exercise_id: 'pull-up',
        exercise_name: 'Pull-up',
        sets: 1,
        max_reps: 8,
        max_seconds: null,
        volume: null,
      }),
      expect.objectContaining({
        exercise_id: 'squat',
        exercise_name: 'Squat',
        sets: 0,
        max_reps: null,
        max_seconds: null,
        volume: null,
        mean_rir: null,
        pr: null,
      }),
    ]);
    expect(overview.indicators).toMatchObject({
      trainings_completed: 1,
      volume: null,
      mean_rir: null,
      mean_rpe: null,
    });
    const first = await reader.getAuthorizedOverview(owner, owner, period, {
      identification: 'identified',
      limit: 2,
    });
    expect(first.exercises.map((item) => item.exercise_id)).toEqual([
      'lunge',
      'pull-up',
    ]);
    expect(first.next_cursor).toEqual(expect.any(String));
    const second = await reader.getAuthorizedOverview(owner, owner, period, {
      identification: 'identified',
      limit: 2,
      cursor: first.next_cursor!,
    });
    expect(second.exercises.map((item) => item.exercise_id)).toEqual(['squat']);
    expect(second.next_cursor).toBeNull();
    const searched = await reader.getAuthorizedOverview(owner, owner, period, {
      identification: 'identified',
      search: 'squat',
      limit: 2,
    });
    expect(searched.exercises.map((item) => item.exercise_id)).toEqual([
      'squat',
    ]);
  });

  it('includes a confirmed completed exercise with explicit JSON null sets and its own snapshot name', async () => {
    const owner = await client();
    const other = await client();
    const day = '2026-09-24';
    const period = { from: day, to: day };
    await db.dayProgress.create({
      data: {
        client_id: owner,
        date: date(day),
        training_sessions: [
          {
            training_id: 'null-sets-training',
            training_session_id: 'performed',
          },
        ],
        exercises_completed: [
          {
            exercise_id: 'null-sets-lift',
            training_exercise_id: 'null-sets-occurrence',
            training_session_id: 'performed',
            sets: null,
          },
        ],
      },
    });
    await db.trainingDaySnapshot.create({
      data: {
        client_id: owner,
        date: date(day),
        training_id: 'null-sets-training',
        version: 1,
        payload: {
          exercises: [
            {
              id: 'null-sets-occurrence',
              exercise_id: 'null-sets-lift',
              exercise: { name: 'Historical null-sets lift' },
            },
          ],
        },
      },
    });

    const overview = await reader.getAuthorizedOverview(owner, owner, period);
    expect(overview.exercises).toEqual([
      expect.objectContaining({
        exercise_id: 'null-sets-lift',
        exercise_name: 'Historical null-sets lift',
        sets: 0,
        max_reps: null,
        max_seconds: null,
        volume: null,
        mean_rir: null,
        pr: null,
      }),
    ]);
    expect(overview.indicators).toMatchObject({
      trainings_completed: 1,
      volume: null,
      mean_rir: null,
      mean_rpe: null,
    });
    await expect(
      reader.getAuthorizedOverview(other, owner, period),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('does not revive an explicitly unconfirmed session from its legacy training ID', async () => {
    const id = await client();
    await db.dayProgress.createMany({
      data: [
        {
          client_id: id,
          date: date('2026-09-23'),
          trainings_completed: ['draft', 'unrelated-legacy'],
          training_sessions: [
            {
              training_id: 'draft',
              training_session_id: 'draft-session',
              confirmed: false,
            },
          ],
        },
        {
          client_id: id,
          date: date('2026-09-24'),
          training_completed: true,
          trainings_completed: ['historical'],
        },
      ],
    });
    const overview = await reader.getAuthorizedOverview(id, id, {
      from: '2026-09-23',
      to: '2026-09-24',
    });
    expect(overview.indicators.trainings_completed).toBe(1);
    expect(overview.indicators.mean_rpe).toBeNull();
    expect(
      (
        await db.dayProgress.findUniqueOrThrow({
          where: {
            client_id_date: { client_id: id, date: date('2026-09-23') },
          },
        })
      ).trainings_completed,
    ).toEqual(['draft', 'unrelated-legacy']);
  });

  it.each([
    ['string false', 'false'],
    ['JSON null', null],
    ['numeric zero', 0],
  ])(
    'does not complete or revive a malformed %s session from an incomplete legacy day',
    async (_label, confirmed) => {
      const owner = await client();
      const day = '2026-09-24';
      await db.dayProgress.create({
        data: {
          client_id: owner,
          date: date(day),
          training_completed: false,
          trainings_completed: ['ambiguous'],
          training_sessions: [
            {
              training_id: 'ambiguous',
              training_session_id: 'explicit',
              confirmed,
              rpe: 8,
            },
          ],
        },
      });
      const before = await db.dayProgress.findUniqueOrThrow({
        where: { client_id_date: { client_id: owner, date: date(day) } },
      });
      const overview = await reader.getAuthorizedOverview(owner, owner, {
        from: day,
        to: day,
      });
      expect(overview.indicators).toMatchObject({
        trainings_completed: 0,
        mean_rpe: null,
      });
      expect(
        await db.dayProgress.findUniqueOrThrow({
          where: { client_id_date: { client_id: owner, date: date(day) } },
        }),
      ).toEqual(before);
    },
  );

  it('rejects malformed JSON, conflicting sessions, invalid numbers and overflowing terms without losing valid values', async () => {
    const id = await client();
    await db.dayProgress.create({
      data: {
        client_id: id,
        date: date('2026-09-24'),
        training_sessions: [
          {
            training_id: 'conflict',
            training_session_id: 'x',
            rpe: 4,
            note: 'one',
          },
          {
            training_id: 'conflict',
            training_session_id: 'x',
            rpe: 9,
            note: 'two',
          },
          { training_id: 'valid', training_session_id: 'y', rpe: 0 },
          { training_id: 'valid', training_session_id: 'z', rpe: 7 },
        ],
        exercises_completed: [
          {
            exercise_id: 'valid',
            sets: [
              { set_number: 1, weight_kg: 3, reps: 5, rir: 0 },
              { set_number: 2, weight_kg: 1e308, reps: 2, rir: 11 },
              { set_number: 3, weight_kg: -1, reps: 4 },
              { set_number: 4, weight_kg: 5, seconds: 'bad', reps: 10 },
            ],
          },
          { exercise_id: 'invalid', sets: 'wrong' },
          null,
          5,
        ],
      },
    });
    const result = await reader.getAuthorizedOverview(id, id, {
      from: '2026-09-24',
      to: '2026-09-24',
    });
    expect(result.indicators).toMatchObject({
      trainings_completed: 1,
      volume: null,
      mean_rir: 0,
      mean_rpe: 7,
    });
    expect(result.exercises).toEqual([
      expect.objectContaining({
        exercise_id: 'valid',
        volume: null,
        sets: 4,
        mean_rir: 0,
      }),
    ]);
    expect(result.exercises[0].pr).toMatchObject({ weight_kg: 1e308, reps: 2 });
  });

  it('reports an unrepresentable daily sum as unavailable, not zero, while preserving finite sums', async () => {
    const giant = await client();
    await db.dayProgress.create({
      data: {
        client_id: giant,
        date: date('2026-09-24'),
        exercises_completed: [
          {
            exercise_id: 'a',
            sets: [{ set_number: 1, weight_kg: 1e308, reps: 1 }],
          },
          {
            exercise_id: 'b',
            sets: [{ set_number: 1, weight_kg: 1e308, reps: 1 }],
          },
          {
            exercise_id: 'timer',
            sets: [{ set_number: 1, weight_kg: 100, seconds: 30, reps: 999 }],
          },
        ],
      },
    });
    const result = await reader.getAuthorizedOverview(giant, giant, {
      from: '2026-09-24',
      to: '2026-09-24',
    });
    expect(result.indicators.volume).toBeNull();
    expect(result.exercises.map((exercise) => exercise.volume)).toEqual([
      1e308,
      1e308,
      null,
    ]);
    expect(result.exercises[2].max_seconds).toBe(30);

    const finite = await client();
    await db.dayProgress.create({
      data: {
        client_id: finite,
        date: date('2026-09-24'),
        exercises_completed: [
          {
            exercise_id: 'a',
            sets: [{ set_number: 1, weight_kg: 2, reps: 3 }],
          },
          {
            exercise_id: 'b',
            sets: [{ set_number: 1, weight_kg: 4, reps: 5 }],
          },
        ],
      },
    });
    expect(
      (
        await reader.getAuthorizedOverview(finite, finite, {
          from: '2026-09-24',
          to: '2026-09-24',
        })
      ).indicators.volume,
    ).toBe(26);
  });

  it('ignores malformed legacy types and tombstones duplicate sessions with conflicting notes or RPE', async () => {
    const id = await client();
    await db.dayProgress.create({
      data: {
        client_id: id,
        date: date('2026-09-24'),
        training_completed: true,
        trainings_completed: ['legacy'],
        training_sessions: [
          { training_id: 'bad', training_session_id: 'a', rpe: 'not-a-number' },
          { training_id: 'bad', training_session_id: 'b', rpe: 1e308 },
          {
            training_id: 'note',
            training_session_id: 'c',
            rpe: 4,
            note: 'first',
          },
          {
            training_id: 'note',
            training_session_id: 'c',
            rpe: 4,
            note: 'second',
          },
          { training_id: 'rpe', training_session_id: 'd', rpe: 4 },
          { training_id: 'rpe', training_session_id: 'd', rpe: 8 },
          { training_id: 'good', training_session_id: 'e', rpe: 6 },
        ],
        exercises_completed: [
          {
            exercise_id: 'invalid',
            sets: [
              { set_number: 'one', weight_kg: 'not-a-number', reps: '2' },
              {
                set_number: 1,
                weight_kg: 'not-a-number',
                reps: 2,
                seconds: 'bad',
              },
              { set_number: 2, weight_kg: 2, reps: 'not-a-number' },
            ],
          },
        ],
      },
    });
    const result = await reader.getAuthorizedOverview(id, id, {
      from: '2026-09-24',
      to: '2026-09-24',
    });
    expect(result.indicators).toMatchObject({
      trainings_completed: 2,
      volume: null,
      mean_rpe: 6,
    });
    expect(result.exercises).toEqual([
      expect.objectContaining({
        exercise_id: 'invalid',
        sets: 2,
        volume: null,
      }),
    ]);
  });

  it.each([
    [
      'invalid RPE',
      { training_id: 'claimed', training_session_id: 'same', rpe: 4 },
      { training_id: 'claimed', training_session_id: 'same', rpe: 'invalid' },
    ],
    [
      'different training',
      { training_id: 'claimed', training_session_id: 'same', rpe: 4 },
      { training_id: 'other-training', training_session_id: 'same', rpe: 8 },
    ],
    [
      'contradictory note',
      {
        training_id: 'claimed',
        training_session_id: 'same',
        rpe: 4,
        note: 'first',
      },
      {
        training_id: 'claimed',
        training_session_id: 'same',
        rpe: 4,
        note: 'second',
      },
    ],
  ])(
    'quarantines %s on the same date and session in either order',
    async (_name, first, second) => {
      const results: TrainingReadOverview['indicators'][] = [];
      for (const claims of [
        [first, second],
        [second, first],
      ]) {
        const id = await client();
        await db.dayProgress.create({
          data: {
            client_id: id,
            date: date('2026-09-24'),
            training_completed: true,
            trainings_completed: [
              'claimed',
              ...(second.training_id === 'other-training'
                ? ['other-training']
                : []),
              'unknown-legacy',
            ],
            training_sessions: [
              ...claims,
              { training_id: 'unrelated', training_session_id: 'good', rpe: 9 },
            ],
          },
        });
        results.push(
          (
            await reader.getAuthorizedOverview(id, id, {
              from: '2026-09-24',
              to: '2026-09-24',
            })
          ).indicators,
        );
      }
      expect(results).toEqual([
        expect.objectContaining({ trainings_completed: 2, mean_rpe: 9 }),
        expect.objectContaining({ trainings_completed: 2, mean_rpe: 9 }),
      ]);
    },
  );

  it('pages load sets across repeated same-day sessions and entries without mixing clients or timed volume', async () => {
    const id = await client();
    const other = await client();
    const sets = Array.from({ length: 27 }, (_, index) => ({
      set_number: index + 1,
      reps: index === 0 ? 1 : 5,
      seconds: index === 1 ? 30 : undefined,
      weight_kg: index === 0 ? 0 : 12,
      rir: index === 0 ? 0 : 2,
    }));
    await db.dayProgress.create({
      data: {
        client_id: id,
        date: date('2026-09-24'),
        exercises_completed: [
          {
            exercise_id: 'squat',
            training_session_id: 'first',
            sets: sets.slice(0, 13),
          },
          {
            exercise_id: 'squat',
            training_session_id: 'second',
            sets: sets.slice(13),
          },
          {
            exercise_id: 'other',
            sets: [{ set_number: 1, reps: 100, weight_kg: 999 }],
          },
        ],
      },
    });
    await db.dayProgress.create({
      data: {
        client_id: other,
        date: date('2026-09-24'),
        exercises_completed: [
          { exercise_id: 'squat', sets: [{ set_number: 1, reps: 99 }] },
        ],
      },
    });
    const first = await reader.getAuthorizedExerciseLoadHistory(
      id,
      id,
      'squat',
      {
        from: '2026-09-24',
        to: '2026-09-24',
      },
    );
    expect(first.page).toHaveLength(25);
    expect(first.nextCursor).toEqual(expect.any(String));
    const last = await reader.getAuthorizedExerciseLoadHistory(
      id,
      id,
      'squat',
      {
        from: '2026-09-24',
        to: '2026-09-24',
      },
      { cursor: first.nextCursor! },
    );
    expect(last.nextCursor).toBeNull();
    expect([...first.page, ...last.page]).toHaveLength(27);
    expect([...first.page, ...last.page].map((row) => row.set_number)).toEqual(
      Array.from({ length: 27 }, (_, index) => index + 1),
    );
    expect(first.page[0]).toMatchObject({
      training_session_id: 'first',
      reps: 1,
      weight_kg: 0,
      rir: 0,
    });
    expect(first.page[1]).toMatchObject({
      seconds: 30,
      reps: null,
      volume: null,
    });
    expect(last.page[0].training_session_id).toBe('second');
    await expect(
      reader.getAuthorizedExerciseLoadHistory(
        other,
        other,
        'squat',
        { from: '2026-09-24', to: '2026-09-24' },
        { cursor: first.nextCursor! },
      ),
    ).rejects.toThrow();
    await expect(
      reader.getAuthorizedExerciseLoadHistory(
        id,
        id,
        'squat',
        { from: '2026-09-23', to: '2026-09-24' },
        { cursor: first.nextCursor! },
      ),
    ).rejects.toThrow();
  });

  it.each([
    ['zero seconds', { seconds: 0, weight_kg: 30, reps: 4 }],
    ['fractional seconds', { seconds: 1.5, weight_kg: 30, reps: 4 }],
    ['fractional reps', { reps: 1.5, weight_kg: 30 }],
    ['RIR above ten', { reps: 4, weight_kg: 30, rir: 11 }],
  ])('rejects malformed %s in the requested load page', async (_label, set) => {
    const id = await client();
    await db.dayProgress.create({
      data: {
        client_id: id,
        date: date('2026-09-24'),
        exercises_completed: [
          { exercise_id: 'lift', sets: [{ set_number: 1, ...set }] },
        ],
      },
    });
    await expect(
      reader.getAuthorizedExerciseLoadHistory(id, id, 'lift', range),
    ).rejects.toThrow(/Malformed historical/);
  });

  it('counts explicit null seconds as repetitions and weight volume, but positive seconds as timed', async () => {
    const owner = await client();
    await db.dayProgress.create({
      data: {
        client_id: owner,
        date: date('2026-09-24'),
        exercises_completed: [
          {
            exercise_id: 'lift',
            sets: [{ set_number: 1, reps: 5, seconds: null, weight_kg: 20 }],
          },
          {
            exercise_id: 'timer',
            sets: [{ set_number: 1, reps: 99, seconds: 30, weight_kg: 20 }],
          },
        ],
      },
    });
    const overview = await reader.getAuthorizedOverview(owner, owner, {
      from: '2026-09-24',
      to: '2026-09-24',
    });
    expect(overview.indicators.volume).toBe(100);
    expect(overview.exercises).toEqual([
      expect.objectContaining({
        exercise_id: 'lift',
        max_reps: 5,
        volume: 100,
      }),
      expect.objectContaining({
        exercise_id: 'timer',
        max_reps: null,
        max_seconds: 30,
        volume: null,
      }),
    ]);
  });

  it('retains zero values and timed semantics across duplicate set numbers and entry ordinals', async () => {
    const id = await client();
    await db.dayProgress.create({
      data: {
        client_id: id,
        date: date('2026-09-24'),
        exercises_completed: [
          {
            exercise_id: 'lift',
            training_session_id: 'first',
            sets: [{ set_number: 1, reps: 2, weight_kg: 0, rir: 0 }],
          },
          {
            exercise_id: 'other',
            sets: [{ set_number: 1, reps: 5, weight_kg: 7 }],
          },
          {
            exercise_id: 'lift',
            training_session_id: 'second',
            sets: [{ set_number: 1, seconds: 30, reps: 99, weight_kg: 50 }],
          },
        ],
      },
    });
    const first = await reader.getAuthorizedExerciseLoadHistory(
      id,
      id,
      'lift',
      range,
      { limit: 1 },
    );
    expect(first.page).toEqual([
      expect.objectContaining({
        training_session_id: 'first',
        set_number: 1,
        weight_kg: 0,
        rir: 0,
        volume: 0,
      }),
    ]);
    expect(first.nextCursor).toEqual(expect.any(String));
    await expect(
      reader.getAuthorizedExerciseLoadHistory(id, id, 'other', range, {
        cursor: first.nextCursor!,
      }),
    ).rejects.toThrow('Invalid exercise load cursor');
    const second = await reader.getAuthorizedExerciseLoadHistory(
      id,
      id,
      'lift',
      range,
      {
        limit: 1,
        cursor: first.nextCursor!,
      },
    );
    expect(second).toEqual({
      page: [
        expect.objectContaining({
          training_session_id: 'second',
          set_number: 1,
          seconds: 30,
          reps: null,
          weight_kg: 50,
          volume: null,
        }),
      ],
      nextCursor: null,
    });
  });

  it('limits the maximum page to 100 sets plus one lookahead across dates', async () => {
    const id = await client();
    await db.dayProgress.createMany({
      data: [
        {
          client_id: id,
          date: date('2026-09-24'),
          exercises_completed: [
            {
              exercise_id: 'lift',
              sets: Array.from({ length: 100 }, (_, index) => ({
                set_number: index + 1,
                reps: 3,
                weight_kg: 0,
              })),
            },
          ],
        },
        {
          client_id: id,
          date: date('2026-09-23'),
          exercises_completed: [
            { exercise_id: 'lift', sets: [{ set_number: 1, reps: 4 }] },
          ],
        },
      ],
    });
    const first = await reader.getAuthorizedExerciseLoadHistory(
      id,
      id,
      'lift',
      range,
      { limit: 100 },
    );
    expect(first.page).toHaveLength(100);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await reader.getAuthorizedExerciseLoadHistory(
      id,
      id,
      'lift',
      range,
      {
        limit: 100,
        cursor: first.nextCursor!,
      },
    );
    expect(second).toMatchObject({
      nextCursor: null,
      page: [{ date: '2026-09-23', training_session_id: null, reps: 4 }],
    });
  });

  it('refuses invalid dates, page limits, cursors and malformed historical arrays', async () => {
    const id = await client();
    await expect(
      reader.getAuthorizedExerciseLoadHistory(id, id, 'x', {
        from: '2026-02-30',
        to: '2026-09-24',
      }),
    ).rejects.toThrow();
    await expect(
      reader.getAuthorizedExerciseLoadHistory(id, id, 'x', {
        from: '2026-09-25',
        to: '2026-09-24',
      }),
    ).rejects.toThrow();
    await expect(
      reader.getAuthorizedExerciseLoadHistory(id, id, 'x', range, {
        limit: 101,
      }),
    ).rejects.toThrow();
    await expect(
      reader.getAuthorizedExerciseLoadHistory(id, id, 'x', range, { limit: 0 }),
    ).rejects.toThrow();
    await expect(
      reader.getAuthorizedExerciseLoadHistory(id, id, 'x', range, {
        cursor: 'bad',
      }),
    ).rejects.toThrow();
    await db.dayProgress.create({
      data: {
        client_id: id,
        date: date('2026-09-24'),
        exercises_completed: [{ exercise_id: 'x', sets: 'corrupt' }],
      },
    });
    await expect(
      reader.getAuthorizedExerciseLoadHistory(id, id, 'x', range),
    ).rejects.toThrow();
  });

  it('isolates confirmed session detail and paginates performed sets by entry and set ordinal', async () => {
    type Detail = {
      training_id: string;
      training_session_id: string;
      rpe: number | null;
      note: string | null;
      page: Array<{
        exercise_id: string;
        training_exercise_id: string | null;
        set_number: number | null;
        reps: number | null;
        seconds: number | null;
        weight_kg: number | null;
        rir: number | null;
      }>;
      nextCursor: string | null;
    } | null;
    type DetailReader = {
      getAuthorizedSessionDetail: (
        actorId: string,
        clientId: string,
        date: string,
        sessionId: string,
        options?: { limit?: number; cursor?: string },
      ) => Promise<Detail>;
    };
    const detailReader = reader as TrainingProgressReadService & DetailReader;
    const owner = await client();
    const other = await client();
    const day = '2026-09-24';
    const firstSets = Array.from({ length: 24 }, (_, index) => ({
      set_number: index + 1,
      reps: index + 1,
      weight_kg: 0,
      rir: 0,
    }));
    await db.dayProgress.create({
      data: {
        client_id: owner,
        date: date(day),
        notes: 'Legacy daily note belongs to neither execution',
        training_sessions: [
          {
            training_id: 'training',
            training_session_id: 'first',
            rpe: 6,
            note: 'first note',
          },
          {
            training_id: 'training',
            training_session_id: 'second',
            rpe: 9,
            note: 'second note',
          },
        ],
        exercises_completed: [
          {
            exercise_id: 'squat',
            training_session_id: 'first',
            sets: [{ set_number: 1, reps: 3, weight_kg: 30 }],
          },
          {
            exercise_id: 'squat',
            training_session_id: 'second',
            training_exercise_id: 'prescribed-squat',
            sets: firstSets,
          },
          {
            exercise_id: 'plank',
            training_session_id: 'second',
            sets: [
              { set_number: 1, seconds: 45, weight_kg: 10 },
              { set_number: 2, reps: 2, weight_kg: 40 },
            ],
          },
          {
            exercise_id: 'plank',
            training_session_id: 'provisional',
            sets: [{ set_number: 1, seconds: 30 }],
          },
        ],
      },
    });
    await db.dayProgress.create({
      data: {
        client_id: owner,
        date: date('2026-09-23'),
        training_sessions: [
          {
            training_id: 'training',
            training_session_id: 'second',
            rpe: 4,
            note: 'yesterday',
          },
        ],
        exercises_completed: [
          {
            exercise_id: 'squat',
            training_session_id: 'second',
            sets: [{ set_number: 1, reps: 99 }],
          },
        ],
      },
    });
    await db.dayProgress.create({
      data: {
        client_id: other,
        date: date(day),
        training_sessions: [
          {
            training_id: 'private',
            training_session_id: 'second',
            rpe: 10,
            note: 'private',
          },
        ],
        exercises_completed: [
          {
            exercise_id: 'private',
            training_session_id: 'second',
            sets: [{ set_number: 1, reps: 99 }],
          },
        ],
      },
    });
    const detail = (
      clientId: string,
      dateValue: string,
      sessionId: string,
      options?: { limit?: number; cursor?: string },
    ) =>
      detailReader.getAuthorizedSessionDetail(
        owner,
        clientId,
        dateValue,
        sessionId,
        options,
      );
    const first = await detail(owner, day, 'first');
    expect(first).toMatchObject({
      training_id: 'training',
      training_session_id: 'first',
      rpe: 6,
      note: 'first note',
      page: [{ exercise_id: 'squat', reps: 3 }],
    });
    expect(first?.nextCursor).toBeNull();
    const second = await detail(owner, day, 'second');
    expect(second).toMatchObject({
      training_id: 'training',
      training_session_id: 'second',
      rpe: 9,
      note: 'second note',
    });
    expect(second?.page).toHaveLength(25);
    expect(second?.page[0]).toMatchObject({
      exercise_id: 'squat',
      training_exercise_id: 'prescribed-squat',
      set_number: 1,
      reps: 1,
      weight_kg: 0,
      rir: 0,
    });
    expect(second?.page[23]).toMatchObject({
      exercise_id: 'squat',
      set_number: 24,
      reps: 24,
    });
    expect(second?.page[24]).toMatchObject({
      exercise_id: 'plank',
      set_number: 1,
      seconds: 45,
      reps: null,
    });
    expect(second?.nextCursor).toEqual(expect.any(String));
    const tail = await detail(owner, day, 'second', {
      cursor: second!.nextCursor!,
    });
    expect(tail).toMatchObject({
      page: [{ exercise_id: 'plank', set_number: 2, reps: 2 }],
      nextCursor: null,
    });
    expect(await detail(owner, '2026-09-23', 'second')).toMatchObject({
      rpe: 4,
      note: 'yesterday',
      page: [{ reps: 99 }],
    });
    expect(await detail(owner, day, 'provisional')).toBeNull();
    expect(JSON.stringify([first, second, tail])).not.toContain(
      'Legacy daily note',
    );
    expect(JSON.stringify([first, second, tail])).not.toContain('private');
    await expect(detail(other, day, 'second')).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      detail(owner, day, 'second', { cursor: 'invalid' }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      detail(owner, day, 'second', { limit: 101 }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      detail(owner, day, 'second', { limit: 0 }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(detail(owner, '2026-02-30', 'second')).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      detail(owner, day, 'first', { cursor: second!.nextCursor! }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      detail(owner, '2026-09-23', 'second', { cursor: second!.nextCursor! }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      detailReader.getAuthorizedSessionDetail(other, owner, day, 'second', {
        cursor: 'invalid',
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      detailReader.getAuthorizedSessionDetail(
        other,
        owner,
        '2026-02-30',
        'second',
      ),
    ).rejects.toMatchObject({ status: 403 });
    const corrupt = await client();
    await db.dayProgress.create({
      data: {
        client_id: corrupt,
        date: date(day),
        training_sessions: 'not an array',
        exercises_completed: [
          {
            exercise_id: 'private',
            training_session_id: 'broken',
            sets: 'malformed',
          },
        ],
      },
    });
    await expect(
      detailReader.getAuthorizedSessionDetail(owner, corrupt, day, 'broken'),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('rejects contradictory confirmed session claims regardless of JSON order and does not attribute daily notes', async () => {
    type DetailReader = {
      getAuthorizedSessionDetail: (
        actorId: string,
        clientId: string,
        date: string,
        sessionId: string,
      ) => Promise<unknown>;
    };
    const detailReader = reader as TrainingProgressReadService & DetailReader;
    for (const claims of [
      [
        {
          training_id: 'A',
          training_session_id: 'duplicate',
          rpe: 4,
          note: 'one',
        },
        {
          training_id: 'A',
          training_session_id: 'duplicate',
          rpe: 8,
          note: 'two',
        },
      ],
      [
        {
          training_id: 'A',
          training_session_id: 'duplicate',
          rpe: 8,
          note: 'two',
        },
        {
          training_id: 'A',
          training_session_id: 'duplicate',
          rpe: 4,
          note: 'one',
        },
      ],
    ]) {
      const owner = await client();
      await db.dayProgress.create({
        data: {
          client_id: owner,
          date: date('2026-09-24'),
          notes: 'daily legacy only',
          training_sessions: claims,
        },
      });
      await expect(
        detailReader.getAuthorizedSessionDetail(
          owner,
          owner,
          '2026-09-24',
          'duplicate',
        ),
      ).rejects.toMatchObject({ status: 400 });
    }
    const owner = await client();
    await db.dayProgress.create({
      data: {
        client_id: owner,
        date: date('2026-09-24'),
        notes: 'daily legacy only',
        training_completed: true,
        trainings_completed: ['legacy'],
      },
    });
    expect(
      await detailReader.getAuthorizedSessionDetail(
        owner,
        owner,
        '2026-09-24',
        'legacy',
      ),
    ).toBeNull();
  });

  it.each([
    [
      'different training',
      { training_id: 'A', training_session_id: 'same', rpe: 4, note: 'one' },
      { training_id: 'B', training_session_id: 'same', rpe: 8, note: 'two' },
    ],
    [
      'different RPE and note',
      { training_id: 'A', training_session_id: 'same', rpe: 4, note: 'one' },
      { training_id: 'A', training_session_id: 'same', rpe: 8, note: 'two' },
    ],
  ])(
    'rejects %s for the same session in the list in either order',
    async (_label, first, second) => {
      for (const claims of [
        [first, second],
        [second, first],
      ]) {
        const owner = await client();
        await db.dayProgress.create({
          data: {
            client_id: owner,
            date: date('2026-09-24'),
            training_sessions: claims,
          },
        });
        await expect(
          reader.getAuthorizedSessionList(owner, owner, {
            from: '2026-09-24',
            to: '2026-09-24',
          }),
        ).rejects.toMatchObject({ status: 400 });
      }
    },
  );

  it('lists an identical duplicate once across pages but keeps distinct session IDs independent', async () => {
    const owner = await client();
    const day = '2026-09-24';
    await db.dayProgress.create({
      data: {
        client_id: owner,
        date: date(day),
        training_sessions: [
          {
            training_id: 'A',
            training_session_id: 'same',
            rpe: 6,
            note: 'one',
          },
          {
            training_id: 'A',
            training_session_id: 'same',
            rpe: 6,
            note: 'one',
          },
          {
            training_id: 'A',
            training_session_id: 'other',
            rpe: 8,
            note: 'two',
          },
        ],
      },
    });
    const period = { from: day, to: day };
    const first = await reader.getAuthorizedSessionList(owner, owner, period, {
      limit: 1,
    });
    expect(first.page).toEqual([
      expect.objectContaining({ training_session_id: 'same', rpe: 6 }),
    ]);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await reader.getAuthorizedSessionList(owner, owner, period, {
      limit: 1,
      cursor: first.nextCursor!,
    });
    expect(second.page).toEqual([
      expect.objectContaining({ training_session_id: 'other', rpe: 8 }),
    ]);
    expect(second.nextCursor).toBeNull();
  });

  it('caps session detail at 100 performed sets and binds its cursor to the client, date and session', async () => {
    type Page = {
      page: Array<{ set_number: number }>;
      nextCursor: string | null;
    };
    type DetailReader = {
      getAuthorizedSessionDetail: (
        actorId: string,
        clientId: string,
        date: string,
        sessionId: string,
        options?: { limit?: number; cursor?: string },
      ) => Promise<Page>;
    };
    const detailReader = reader as TrainingProgressReadService & DetailReader;
    const owner = await client();
    await db.dayProgress.create({
      data: {
        client_id: owner,
        date: date('2026-09-24'),
        training_sessions: [
          { training_id: 'A', training_session_id: 's', rpe: 5 },
        ],
        exercises_completed: [
          {
            exercise_id: 'lift',
            training_session_id: 's',
            sets: Array.from({ length: 101 }, (_, index) => ({
              set_number: index + 1,
              reps: 1,
            })),
          },
        ],
      },
    });
    const page = await detailReader.getAuthorizedSessionDetail(
      owner,
      owner,
      '2026-09-24',
      's',
      { limit: 100 },
    );
    if (!page) throw new Error('Expected session detail page');
    expect(page.page).toHaveLength(100);
    expect(page.page.map((set) => set.set_number)).toEqual(
      Array.from({ length: 100 }, (_, index) => index + 1),
    );
    expect(page.nextCursor).toEqual(expect.any(String));
    const tail = await detailReader.getAuthorizedSessionDetail(
      owner,
      owner,
      '2026-09-24',
      's',
      { limit: 100, cursor: page.nextCursor! },
    );
    if (!tail) throw new Error('Expected session detail tail');
    expect(tail.page.map((set) => set.set_number)).toEqual([101]);
    expect(tail.nextCursor).toBeNull();
  });

  it('keeps a read-only repeatable-read snapshot while an external writer changes the row', async () => {
    const id = await client();
    await db.dayProgress.create({
      data: {
        client_id: id,
        date: date('2026-09-24'),
        training_completed: true,
        trainings_completed: ['legacy'],
        exercises_completed: [
          {
            exercise_id: 'x',
            sets: [{ set_number: 1, weight_kg: 1, reps: 1 }],
          },
        ],
      },
    });
    const snapshot = await db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        const first = await reader.getAuthorizedOverviewInTransaction(
          tx,
          id,
          id,
          {
            from: '2026-09-24',
            to: '2026-09-24',
          },
        );
        await db.dayProgress.update({
          where: {
            client_id_date: { client_id: id, date: date('2026-09-24') },
          },
          data: {
            trainings_completed: ['legacy', 'new'],
            exercises_completed: [],
          },
        });
        const second = await reader.getAuthorizedOverviewInTransaction(
          tx,
          id,
          id,
          {
            from: '2026-09-24',
            to: '2026-09-24',
          },
        );
        expect(second).toEqual(first);
        await expect(
          tx.$executeRaw`UPDATE day_progress SET training_completed = true WHERE client_id = ${id}`,
        ).rejects.toThrow();
        return first;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    expect(snapshot.indicators).toMatchObject({
      trainings_completed: 1,
      volume: 1,
    });
    expect(
      (
        await reader.getAuthorizedOverview(id, id, {
          from: '2026-09-24',
          to: '2026-09-24',
        })
      ).indicators,
    ).toMatchObject({ trainings_completed: 2, volume: null });
  });
});
