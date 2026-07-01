import { CalendarService } from './calendar.service';

describe('CalendarService', () => {
  const prisma = {
    planAssignment: { findMany: jest.fn() },
    dayProgress: { findMany: jest.fn() },
  };
  const materializer = { materialize: jest.fn() };
  const service = new CalendarService(prisma as never, materializer as never);

  beforeEach(() => {
    jest.clearAllMocks();
    materializer.materialize.mockResolvedValue(undefined);
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
    expect(materializer.materialize).toHaveBeenCalledWith(
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
    expect(materializer.materialize).toHaveBeenLastCalledWith(
      'client-1',
      expect.objectContaining({
        start: new Date('2026-06-08T00:00:00.000Z'),
        end: new Date('2026-06-14T00:00:00.000Z'),
      }),
    );
    expect(summary).toMatchObject({ total_meals: 1, meals_completed: 1 });
  });
});
