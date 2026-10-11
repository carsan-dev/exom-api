import { CalendarService } from './calendar.service';

describe('CalendarService', () => {
  const prisma = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    planAssignment: { findMany: jest.fn() },
    dayProgress: { findMany: jest.fn() },
  };
  const materializer = { reconcile: jest.fn() };
  const service = new CalendarService(prisma as never, materializer as never);

  beforeEach(() => {
    jest.clearAllMocks();
    materializer.reconcile.mockResolvedValue(undefined);
    prisma.$queryRaw.mockResolvedValue([]);
  });

  it('counts full UTC-week diet days with the same completion as the calendar', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-06-30T12:00:00Z'));
    const meals = [
      { id: 'meal-1', parent_meal_id: null },
      { id: 'variant-1', parent_meal_id: 'meal-1' },
      { id: 'meal-2', parent_meal_id: null },
    ];
    const dates = [
      '2026-06-29',
      '2026-06-30',
      '2026-07-01',
      '2026-07-02',
      '2026-07-03',
    ];
    prisma.planAssignment.findMany.mockResolvedValue(
      dates.map((date, index) => ({
        client_id: 'client-1',
        date: new Date(`${date}T00:00:00Z`),
        training_id: null,
        trainings: [],
        is_rest_day: false,
        diet_id: index === 4 ? null : 'diet-1',
        diet: index === 4 ? null : { meals: index === 3 ? [] : meals },
      })),
    );
    prisma.dayProgress.findMany.mockResolvedValue(
      dates.map((date, index) => ({
        client_id: 'client-1',
        date: new Date(`${date}T00:00:00Z`),
        training_completed: false,
        trainings_completed: [],
        meals_completed:
          index === 0
            ? ['meal-1', 'variant-1', 'meal-2', 'stale']
            : index === 1
              ? ['variant-1', 'stale']
              : ['stale'],
      })),
    );
    try {
      const summary = await service.getWeekSummary('client-1', dates[0]);
      expect(summary).toEqual({
        week_start: dates[0],
        trainings_assigned: 0,
        trainings_completed: 0,
        total_meals: 6,
        meals_completed: 3,
        diet_days_assigned: 4,
        diet_days_completed: 1,
      });
      expect(prisma.planAssignment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            client_id: 'client-1',
            date: {
              gte: new Date('2026-06-29T00:00:00Z'),
              lte: new Date('2026-07-05T00:00:00Z'),
            },
          },
        }),
      );
      const june = await service.getMonthCalendar('client-1', 2026, 6);
      const july = await service.getMonthCalendar('client-1', 2026, 7);
      expect(
        [...june, ...july].filter((day) => day.diet_completed),
      ).toHaveLength(1);
      expect([...june, ...july].filter((day) => day.has_diet)).toHaveLength(4);
      expect(july[1]).toMatchObject({ has_diet: true, diet_completed: false });
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps captured historical diet groups after the live catalog changes', async () => {
    const date = new Date('2026-06-29T00:00:00Z');
    prisma.planAssignment.findMany.mockResolvedValue([
      {
        client_id: 'client-1',
        date,
        diet_id: 'diet-1',
        diet: { meals: [] },
        trainings: [],
      },
    ]);
    prisma.dayProgress.findMany.mockResolvedValue([
      {
        client_id: 'client-1',
        date,
        meals_completed: ['old-variant', 'stale'],
        trainings_completed: [],
      },
    ]);
    const snapshot = {
      client_id: 'client-1',
      date,
      diet_id: 'diet-1',
      diet: {
        meals: [
          {
            id: 'old-meal',
            parent_meal_id: null,
            variants: [{ id: 'old-variant', parent_meal_id: 'old-meal' }],
          },
        ],
      },
    };
    prisma.$queryRaw.mockResolvedValue([snapshot]);
    const before = JSON.stringify(snapshot);
    expect(
      await service.getWeekSummary('client-1', '2026-06-29'),
    ).toMatchObject({
      total_meals: 1,
      meals_completed: 1,
      diet_days_assigned: 1,
      diet_days_completed: 1,
    });
    expect(
      (await service.getMonthCalendar('client-1', 2026, 6))[28].diet_completed,
    ).toBe(true);
    expect(JSON.stringify(snapshot)).toBe(before);
  });

  it('returns zero counters when no diet or programming exists', async () => {
    prisma.planAssignment.findMany.mockResolvedValue([]);
    prisma.dayProgress.findMany.mockResolvedValue([
      {
        client_id: 'client-1',
        date: new Date('2026-06-29T00:00:00Z'),
        meals_completed: ['stale-meal'],
        trainings_completed: [],
      },
    ]);
    expect(await service.getWeekSummary('client-1', '2026-06-29')).toEqual({
      week_start: '2026-06-29',
      trainings_assigned: 0,
      trainings_completed: 0,
      total_meals: 0,
      meals_completed: 0,
      diet_days_assigned: 0,
      diet_days_completed: 0,
    });
  });

  it('counts completed meal groups instead of variants or stale ids', async () => {
    prisma.planAssignment.findMany.mockResolvedValue([
      {
        client_id: 'client-1',
        date: new Date('2026-06-10T00:00:00.000Z'),
        training_id: null,
        diet_id: 'diet-1',
        is_rest_day: false,
        diet: {
          meals: [
            { id: 'meal-1', parent_meal_id: null },
            { id: 'variant-1', parent_meal_id: 'meal-1' },
          ],
        },
      },
    ]);
    prisma.dayProgress.findMany.mockResolvedValue([
      {
        client_id: 'client-1',
        date: new Date('2026-06-10T00:00:00.000Z'),
        training_completed: false,
        meals_completed: ['variant-1', 'stale-id'],
      },
    ]);

    const days = await service.getMonthCalendar('client-1', 2026, 6);
    expect(materializer.reconcile).toHaveBeenCalledWith(
      'client-1',
      expect.objectContaining({
        start: new Date('2026-06-01T00:00:00.000Z'),
        end: new Date('2026-06-30T00:00:00.000Z'),
      }),
    );
    expect(days[9]).toMatchObject({
      has_diet: true,
      diet_completed: true,
    });

    const summary = await service.getWeekSummary('client-1', '2026-06-08');
    expect(materializer.reconcile).toHaveBeenLastCalledWith(
      'client-1',
      expect.objectContaining({
        start: new Date('2026-06-08T00:00:00.000Z'),
        end: new Date('2026-06-14T00:00:00.000Z'),
      }),
    );
    expect(summary).toMatchObject({ total_meals: 1, meals_completed: 1 });
  });

  it('does not show replacement trainings as completed from historical ids', async () => {
    prisma.planAssignment.findMany.mockResolvedValue([
      {
        client_id: 'client-1',
        date: new Date('2026-06-10T00:00:00.000Z'),
        training_id: null,
        diet_id: null,
        is_rest_day: false,
        trainings: [
          { training_id: 'training-new-1' },
          { training_id: 'training-new-2' },
        ],
        diet: null,
      },
    ]);
    prisma.dayProgress.findMany.mockResolvedValue([
      {
        client_id: 'client-1',
        date: new Date('2026-06-10T00:00:00.000Z'),
        training_completed: true,
        trainings_completed: ['training-old-1', 'training-old-2'],
        meals_completed: [],
      },
    ]);

    const days = await service.getMonthCalendar('client-1', 2026, 6);

    expect(days[9]).toMatchObject({
      has_training: true,
      training_completed: false,
    });
  });

  it('keeps legacy single-training completion compatibility', async () => {
    prisma.planAssignment.findMany.mockResolvedValue([
      {
        client_id: 'client-1',
        date: new Date('2026-06-10T00:00:00.000Z'),
        training_id: null,
        diet_id: null,
        is_rest_day: false,
        trainings: [{ training_id: 'training-1' }],
        diet: null,
      },
    ]);
    prisma.dayProgress.findMany.mockResolvedValue([
      {
        client_id: 'client-1',
        date: new Date('2026-06-10T00:00:00.000Z'),
        training_completed: true,
        trainings_completed: [],
        meals_completed: [],
      },
    ]);

    const days = await service.getMonthCalendar('client-1', 2026, 6);

    expect(days[9].training_completed).toBe(true);
  });
});
