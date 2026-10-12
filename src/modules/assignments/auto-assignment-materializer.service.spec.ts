import { LastSetVideoPolicy } from '@prisma/client';
import { AutoAssignmentMaterializerService } from './auto-assignment-materializer.service';
import { ASSIGNMENT_TRANSACTION_OPTIONS } from './assignment-planning-lock';

describe('AutoAssignmentMaterializerService', () => {
  const prisma = {
    $queryRaw: jest.fn(),
    $transaction: jest.fn(),
    autoAssignmentRule: { findMany: jest.fn() },
    planAssignment: {
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    dayProgress: { findUnique: jest.fn() },
  };
  const lastSetVideoPolicy = {
    monthsForDates: jest.fn(),
    reconcile: jest.fn(),
  };
  const service = new AutoAssignmentMaterializerService(
    prisma as never,
    lastSetVideoPolicy as never,
  );

  beforeAll(() => {
    jest.useFakeTimers();
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.setSystemTime(new Date('2026-07-01T12:00:00.000Z'));
    prisma.$queryRaw.mockResolvedValue([{ id: 'client-1' }]);
    prisma.$transaction.mockImplementation(
      (callback: (tx: typeof prisma) => unknown) => callback(prisma),
    );
    prisma.autoAssignmentRule.findMany.mockResolvedValue([]);
    prisma.planAssignment.findMany.mockResolvedValue([]);
    prisma.dayProgress.findUnique.mockResolvedValue(null);
    lastSetVideoPolicy.monthsForDates.mockReturnValue(['2026-07']);
    lastSetVideoPolicy.reconcile.mockResolvedValue(undefined);
  });

  it('creates missing dates while preserving occupied manual overrides', async () => {
    prisma.autoAssignmentRule.findMany.mockResolvedValue([
      {
        id: 'rule-1',
        admin_id: 'admin-1',
        starts_on: new Date('2026-06-01T00:00:00.000Z'),
        ends_on: null,
        days: [
          {
            weekday: 4,
            training_id: 'training-rule',
            diet_id: null,
            is_rest_day: false,
            trainings: [],
          },
        ],
      },
    ]);
    prisma.planAssignment.findMany.mockResolvedValue([
      {
        id: 'manual-1',
        admin_id: 'admin-1',
        date: new Date('2026-07-09T00:00:00.000Z'),
        training_id: 'training-manual',
        diet_id: null,
        is_rest_day: false,
        auto_assignment_rule_id: null,
        trainings: [],
      },
    ]);
    const dates = Array.from(
      { length: 31 },
      (_, index) => new Date(Date.UTC(2026, 6, index + 1)),
    );

    await service.reconcile('client-1', {
      start: dates[0],
      end: dates[30],
      dates,
    });

    expect(prisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      ASSIGNMENT_TRANSACTION_OPTIONS,
    );
    // Catalog barrier, client advisory, then user row lock.
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(3);
    expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.autoAssignmentRule.findMany.mock.invocationCallOrder[0],
    );
    expect(prisma.planAssignment.create).toHaveBeenCalledTimes(4);
    const createCalls = prisma.planAssignment.create.mock
      .calls as unknown as Array<[{ data: { date: Date } }]>;
    expect(
      createCalls.map(([call]) => call.data.date.toISOString().slice(0, 10)),
    ).toEqual(['2026-07-02', '2026-07-16', '2026-07-23', '2026-07-30']);
    expect(createCalls[0][0]).toMatchObject({
      data: {
        training_id: 'training-rule',
        auto_assignment_rule_id: 'rule-1',
        trainings: {
          create: [
            {
              training_id: 'training-rule',
              position: 0,
              last_set_video_policy: LastSetVideoPolicy.AUTO,
              requires_last_set_video: false,
            },
          ],
        },
      },
    });
    expect(prisma.planAssignment.update).not.toHaveBeenCalled();
    expect(prisma.planAssignment.delete).not.toHaveBeenCalled();
  });

  it('does not create new assignments from retired rule catalog entries', async () => {
    prisma.autoAssignmentRule.findMany.mockResolvedValue([
      {
        id: 'rule-1',
        admin_id: null,
        starts_on: new Date('2026-07-01'),
        ends_on: null,
        days: [
          {
            weekday: 4,
            training_id: 'retired',
            training: { is_active: false },
            trainings: [
              {
                training_id: 'retired',
                training: { is_active: false },
                last_set_video_policy: LastSetVideoPolicy.NEVER,
              },
            ],
            diet_id: 'retired-diet',
            diet: { is_active: false },
            is_rest_day: false,
          },
        ],
      },
    ]);
    const date = new Date('2026-07-02');
    await service.reconcile('client-1', {
      start: date,
      end: date,
      dates: [date],
    });
    expect(prisma.planAssignment.create).not.toHaveBeenCalled();
  });

  it('updates stale automatic dates, removes obsolete ones, and is idempotent', async () => {
    const rule = {
      id: 'rule-1',
      admin_id: 'admin-2',
      starts_on: new Date('2026-07-01T00:00:00.000Z'),
      ends_on: null,
      days: [
        {
          weekday: 4,
          training_id: 'legacy-wrong',
          diet_id: 'diet-2',
          is_rest_day: false,
          trainings: [
            {
              training_id: 'training-new',
              position: 0,
              last_set_video_policy: LastSetVideoPolicy.NEVER,
            },
          ],
        },
      ],
    };
    prisma.autoAssignmentRule.findMany.mockResolvedValue([rule]);
    prisma.planAssignment.findMany
      .mockResolvedValueOnce([
        {
          id: 'auto-stale',
          admin_id: 'admin-1',
          date: new Date('2026-07-02T00:00:00.000Z'),
          training_id: 'training-old',
          diet_id: null,
          is_rest_day: false,
          auto_assignment_rule_id: 'rule-1',
          trainings: [
            {
              training_id: 'training-old',
              last_set_video_policy: LastSetVideoPolicy.AUTO,
            },
          ],
        },
        {
          id: 'auto-obsolete',
          admin_id: 'admin-1',
          date: new Date('2026-07-03T00:00:00.000Z'),
          training_id: 'training-old',
          diet_id: null,
          is_rest_day: false,
          auto_assignment_rule_id: 'rule-1',
          trainings: [],
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'auto-stale',
          admin_id: 'admin-2',
          date: new Date('2026-07-02T00:00:00.000Z'),
          training_id: 'training-new',
          diet_id: 'diet-2',
          is_rest_day: false,
          auto_assignment_rule_id: 'rule-1',
          trainings: [
            {
              training_id: 'training-new',
              last_set_video_policy: LastSetVideoPolicy.NEVER,
            },
          ],
        },
      ]);
    const range = {
      start: new Date('2026-07-02T00:00:00.000Z'),
      end: new Date('2026-07-03T00:00:00.000Z'),
      dates: [
        new Date('2026-07-02T00:00:00.000Z'),
        new Date('2026-07-03T00:00:00.000Z'),
      ],
    };

    await service.reconcile('client-1', range);
    await service.reconcile('client-1', range);

    expect(prisma.planAssignment.update).toHaveBeenCalledTimes(1);
    const updateCalls = prisma.planAssignment.update.mock
      .calls as unknown as Array<
      [{ where: { id: string }; data: Record<string, unknown> }]
    >;
    expect(updateCalls[0][0]).toMatchObject({
      where: { id: 'auto-stale' },
      data: {
        admin_id: 'admin-2',
        training_id: 'training-new',
        diet_id: 'diet-2',
        auto_assignment_rule_id: 'rule-1',
      },
    });
    expect(prisma.planAssignment.delete).toHaveBeenCalledTimes(1);
    expect(prisma.planAssignment.delete).toHaveBeenCalledWith({
      where: { id: 'auto-obsolete' },
    });
    expect(prisma.planAssignment.create).not.toHaveBeenCalled();
    expect(lastSetVideoPolicy.reconcile).toHaveBeenCalledTimes(1);
  });

  it('never changes past dates or a completed assignment today', async () => {
    prisma.autoAssignmentRule.findMany.mockResolvedValue([
      {
        id: 'rule-1',
        admin_id: 'admin-1',
        starts_on: new Date('2026-01-01T00:00:00.000Z'),
        ends_on: null,
        days: [
          {
            weekday: 3,
            training_id: 'training-new',
            diet_id: null,
            is_rest_day: false,
            trainings: [],
          },
        ],
      },
    ]);
    prisma.planAssignment.findMany.mockResolvedValue([
      {
        id: 'today-auto',
        admin_id: 'admin-1',
        date: new Date('2026-07-01T00:00:00.000Z'),
        training_id: 'training-old',
        diet_id: null,
        is_rest_day: false,
        auto_assignment_rule_id: 'rule-1',
        trainings: [],
      },
    ]);
    prisma.dayProgress.findUnique.mockResolvedValue({
      training_completed: true,
    });

    await service.reconcile('client-1', {
      start: new Date('2026-06-30T00:00:00.000Z'),
      end: new Date('2026-07-01T00:00:00.000Z'),
      dates: [
        new Date('2026-06-30T00:00:00.000Z'),
        new Date('2026-07-01T00:00:00.000Z'),
      ],
    });

    const findManyCalls = prisma.planAssignment.findMany.mock
      .calls as unknown as Array<[{ where: { date: { in: Date[] } } }]>;
    expect(findManyCalls[0][0].where.date.in).toEqual([
      new Date('2026-07-01T00:00:00.000Z'),
    ]);
    expect(prisma.planAssignment.create).not.toHaveBeenCalled();
    expect(prisma.planAssignment.update).not.toHaveBeenCalled();
    expect(prisma.planAssignment.delete).not.toHaveBeenCalled();
  });

  it('reconciles an incomplete automatic assignment today', async () => {
    prisma.autoAssignmentRule.findMany.mockResolvedValue([
      {
        id: 'rule-1',
        admin_id: 'admin-1',
        starts_on: new Date('2026-07-01T00:00:00.000Z'),
        ends_on: null,
        days: [
          {
            weekday: 3,
            training_id: 'training-new',
            diet_id: null,
            is_rest_day: false,
            trainings: [],
          },
        ],
      },
    ]);
    prisma.planAssignment.findMany.mockResolvedValue([
      {
        id: 'today-auto',
        admin_id: 'admin-1',
        date: new Date('2026-07-01T00:00:00.000Z'),
        training_id: 'training-old',
        diet_id: null,
        is_rest_day: false,
        auto_assignment_rule_id: 'rule-1',
        trainings: [],
      },
    ]);
    prisma.dayProgress.findUnique.mockResolvedValue({
      training_completed: false,
    });

    await service.reconcile('client-1', {
      start: new Date('2026-07-01T00:00:00.000Z'),
      end: new Date('2026-07-01T00:00:00.000Z'),
      dates: [new Date('2026-07-01T00:00:00.000Z')],
    });

    const updateCalls = prisma.planAssignment.update.mock
      .calls as unknown as Array<
      [{ where: { id: string }; data: Record<string, unknown> }]
    >;
    expect(updateCalls[0][0]).toMatchObject({
      where: { id: 'today-auto' },
      data: { training_id: 'training-new' },
    });
  });

  it.each([
    {
      kind: 'one completed training',
      progress: {
        training_completed: false,
        trainings_completed: ['training-old'],
        exercises_completed: [],
        meals_completed: [],
        notes: null,
      },
    },
    {
      kind: 'one completed exercise',
      progress: {
        training_completed: false,
        trainings_completed: [],
        exercises_completed: [{ exercise_id: 'exercise-1' }],
        meals_completed: [],
        notes: null,
      },
    },
    {
      kind: 'one completed meal',
      progress: {
        training_completed: false,
        trainings_completed: [],
        exercises_completed: [],
        meals_completed: ['meal-1'],
        notes: null,
      },
    },
    {
      kind: 'a client note',
      progress: {
        training_completed: false,
        trainings_completed: [],
        exercises_completed: [],
        meals_completed: [],
        notes: 'Sesión iniciada',
      },
    },
  ])(
    'preserves an automatic assignment today after $kind',
    async ({ progress }) => {
      prisma.autoAssignmentRule.findMany.mockResolvedValue([
        {
          id: 'rule-1',
          admin_id: 'admin-1',
          starts_on: new Date('2026-07-01T00:00:00.000Z'),
          ends_on: null,
          days: [
            {
              weekday: 3,
              training_id: 'training-new',
              diet_id: null,
              is_rest_day: false,
              trainings: [],
            },
          ],
        },
      ]);
      prisma.planAssignment.findMany.mockResolvedValue([
        {
          id: 'today-auto',
          admin_id: 'admin-1',
          date: new Date('2026-07-01T00:00:00.000Z'),
          training_id: 'training-old',
          diet_id: null,
          is_rest_day: false,
          auto_assignment_rule_id: 'rule-1',
          trainings: [],
        },
      ]);
      prisma.dayProgress.findUnique.mockResolvedValue(progress);

      await service.reconcile('client-1', {
        start: new Date('2026-07-01T00:00:00.000Z'),
        end: new Date('2026-07-01T00:00:00.000Z'),
        dates: [new Date('2026-07-01T00:00:00.000Z')],
      });

      expect(prisma.planAssignment.update).not.toHaveBeenCalled();
      expect(prisma.planAssignment.delete).not.toHaveBeenCalled();
    },
  );

  it('removes future automatic assignments after their rule is deactivated', async () => {
    prisma.autoAssignmentRule.findMany.mockResolvedValue([]);
    prisma.planAssignment.findMany.mockResolvedValue([
      {
        id: 'future-auto',
        admin_id: 'admin-1',
        date: new Date('2026-07-02T00:00:00.000Z'),
        training_id: 'training-old',
        diet_id: null,
        is_rest_day: false,
        auto_assignment_rule_id: 'rule-1',
        trainings: [],
      },
      {
        id: 'future-manual',
        admin_id: 'admin-1',
        date: new Date('2026-07-03T00:00:00.000Z'),
        training_id: 'training-manual',
        diet_id: null,
        is_rest_day: false,
        auto_assignment_rule_id: null,
        trainings: [],
      },
    ]);

    await service.reconcile('client-1', {
      start: new Date('2026-07-02T00:00:00.000Z'),
      end: new Date('2026-07-03T00:00:00.000Z'),
      dates: [
        new Date('2026-07-02T00:00:00.000Z'),
        new Date('2026-07-03T00:00:00.000Z'),
      ],
    });

    expect(prisma.planAssignment.delete).toHaveBeenCalledTimes(1);
    expect(prisma.planAssignment.delete).toHaveBeenCalledWith({
      where: { id: 'future-auto' },
    });
  });

  describe('training completion mode', () => {
    const thursday = new Date('2026-07-02T00:00:00.000Z');
    const rule = (mode?: 'ALL' | 'ANY') => ({
      id: 'rule-1',
      admin_id: 'admin-1',
      ...(mode && { training_completion_mode: mode }),
      starts_on: new Date('2026-06-01T00:00:00.000Z'),
      ends_on: null,
      days: [
        {
          weekday: 4,
          training_id: null,
          diet_id: null,
          is_rest_day: false,
          trainings: [
            {
              training_id: 'training-1',
              last_set_video_policy: LastSetVideoPolicy.AUTO,
            },
            {
              training_id: 'training-2',
              last_set_video_policy: LastSetVideoPolicy.AUTO,
            },
          ],
        },
      ],
    });
    const existing = (mode?: 'ALL' | 'ANY') => ({
      id: 'auto-1',
      admin_id: 'admin-1',
      date: thursday,
      training_id: 'training-1',
      diet_id: null,
      is_rest_day: false,
      auto_assignment_rule_id: 'rule-1',
      ...(mode && { training_completion_mode: mode }),
      trainings: [
        {
          training_id: 'training-1',
          last_set_video_policy: LastSetVideoPolicy.AUTO,
          legacy_video_exempt: false,
        },
        {
          training_id: 'training-2',
          last_set_video_policy: LastSetVideoPolicy.AUTO,
          legacy_video_exempt: false,
        },
      ],
    });
    const update = jest.fn();
    const findUnique = jest.fn();

    beforeEach(() => {
      Object.assign(prisma.dayProgress, { update });
      Object.assign(prisma.planAssignment, { findUnique });
      update.mockReset().mockResolvedValue({});
      findUnique.mockReset().mockResolvedValue({
        training_id: 'training-1',
        training_completion_mode: 'ANY',
        trainings: ['1', '2'].map((n) => ({
          training: {
            id: `training-${n}`,
            exercises: [{ id: `te-${n}`, exercise_id: `exercise-${n}` }],
          },
        })),
        training: null,
      });
      prisma.$queryRaw.mockImplementation((query: { sql: string }) =>
        Promise.resolve(
          query.sql.includes('training_day_snapshots')
            ? []
            : [{ id: 'client-1' }],
        ),
      );
    });

    it('copies the rule mode to a materialized future day and promotes it from evidence', async () => {
      prisma.autoAssignmentRule.findMany.mockResolvedValue([rule('ANY')]);
      prisma.planAssignment.findMany.mockResolvedValue([existing('ALL')]);
      prisma.dayProgress.findUnique.mockResolvedValue({
        id: 'progress-future',
        training_completed: false,
        exercises_completed: [
          { training_exercise_id: 'te-2', exercise_id: 'exercise-2' },
        ],
        training_sessions: [],
      });

      await service.reconcile('client-1', {
        start: thursday,
        end: thursday,
        dates: [thursday],
      });

      const [[updateArgs]] = prisma.planAssignment.update.mock.calls as Array<
        [{ where: { id: string }; data: Record<string, unknown> }]
      >;
      expect(updateArgs.where).toEqual({ id: 'auto-1' });
      expect(updateArgs.data.training_completion_mode).toBe('ANY');
      // Mode-only change: plan_assignment_trainings (and their IDs) are kept.
      expect(updateArgs.data).not.toHaveProperty('trainings');
      expect(update).toHaveBeenCalledWith({
        where: { id: 'progress-future' },
        data: { training_completed: true },
      });
    });

    it('leaves legacy rows untouched when rule and day are both ALL', async () => {
      prisma.autoAssignmentRule.findMany.mockResolvedValue([rule()]);
      prisma.planAssignment.findMany.mockResolvedValue([existing()]);

      await service.reconcile('client-1', {
        start: thursday,
        end: thursday,
        dates: [thursday],
      });

      expect(prisma.planAssignment.update).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    });

    it('creates new rule days with the rule mode', async () => {
      prisma.autoAssignmentRule.findMany.mockResolvedValue([rule('ANY')]);

      await service.reconcile('client-1', {
        start: thursday,
        end: thursday,
        dates: [thursday],
      });

      const [[createArgs]] = prisma.planAssignment.create.mock.calls as Array<
        [{ data: Record<string, unknown> }]
      >;
      expect(createArgs.data.training_completion_mode).toBe('ANY');
    });
  });
});
