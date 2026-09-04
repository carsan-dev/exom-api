import { CalendarService } from './calendar.service';

describe('CalendarService', () => {
  const prisma = {
    planAssignment: { findMany: jest.fn() },
    dayProgress: { findMany: jest.fn() },
  };
  const materializer = { reconcile: jest.fn() };
  const service = new CalendarService(prisma as never, materializer as never);

  beforeEach(() => {
    jest.clearAllMocks();
    materializer.reconcile.mockResolvedValue(undefined);
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
