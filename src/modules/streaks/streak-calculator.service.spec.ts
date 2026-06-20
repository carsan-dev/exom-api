import { PrismaService } from '../../prisma/prisma.service';
import { StreakCalculatorService } from './streak-calculator.service';

describe('StreakCalculatorService', () => {
  let service: StreakCalculatorService;
  let prisma: {
    streak: { findUnique: jest.Mock; findMany: jest.Mock; upsert: jest.Mock };
    planAssignment: { findMany: jest.Mock };
    dayProgress: { findMany: jest.Mock };
    user: { findMany: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      streak: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        upsert: jest.fn().mockResolvedValue({}),
      },
      planAssignment: { findMany: jest.fn().mockResolvedValue([]) },
      dayProgress: { findMany: jest.fn().mockResolvedValue([]) },
      user: { findMany: jest.fn().mockResolvedValue([]) },
    };
    service = new StreakCalculatorService(prisma as unknown as PrismaService);
  });

  it('continues across rest and unassigned calendar days', async () => {
    prisma.planAssignment.findMany.mockResolvedValue([
      { date: new Date('2026-06-18T00:00:00.000Z') },
      { date: new Date('2026-06-22T00:00:00.000Z') },
    ]);
    prisma.dayProgress.findMany.mockResolvedValue([
      {
        date: new Date('2026-06-18T00:00:00.000Z'),
        training_completed: true,
        exercises_completed: [],
        meals_completed: [],
      },
      {
        date: new Date('2026-06-22T00:00:00.000Z'),
        training_completed: false,
        exercises_completed: [],
        meals_completed: ['meal-1'],
      },
    ]);

    const result = await service.recalculateClient('client-1', {
      asOf: new Date('2026-06-22T12:00:00.000Z'),
    });

    expect(result.currentDays).toBe(2);
    expect(prisma.streak.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ current_days: 2, longest_days: 2 }),
      }),
    );
  });

  it('breaks on a missed planned day but not on the open current day', async () => {
    prisma.planAssignment.findMany.mockResolvedValue([
      { date: new Date('2026-06-18T00:00:00.000Z') },
      { date: new Date('2026-06-19T00:00:00.000Z') },
      { date: new Date('2026-06-20T00:00:00.000Z') },
    ]);
    prisma.dayProgress.findMany.mockResolvedValue([
      {
        date: new Date('2026-06-18T00:00:00.000Z'),
        training_completed: false,
        exercises_completed: [{ exercise_id: 'exercise-1' }],
        meals_completed: [],
      },
    ]);

    const result = await service.recalculateClient('client-1', {
      asOf: new Date('2026-06-20T12:00:00.000Z'),
    });

    expect(result.currentDays).toBe(0);
    expect(result.longestDays).toBe(1);
  });

  it('counts at most once per planned date', async () => {
    prisma.planAssignment.findMany.mockResolvedValue([
      { date: new Date('2026-06-20T00:00:00.000Z') },
    ]);
    prisma.dayProgress.findMany.mockResolvedValue([
      {
        date: new Date('2026-06-20T00:00:00.000Z'),
        training_completed: true,
        exercises_completed: [{ exercise_id: 'exercise-1' }],
        meals_completed: ['meal-1'],
      },
    ]);

    const result = await service.recalculateClient('client-1', {
      asOf: new Date('2026-06-20T12:00:00.000Z'),
    });

    expect(result.currentDays).toBe(1);
  });

  it('does not resurrect activity recorded before a manual reset', async () => {
    const resetAt = new Date('2026-06-20T10:00:00.000Z');
    prisma.streak.findUnique.mockResolvedValue({
      current_days: 0,
      longest_days: 8,
      last_active_date: null,
      tracking_started_at: resetAt,
    });
    prisma.planAssignment.findMany.mockResolvedValue([
      { date: new Date('2026-06-20T00:00:00.000Z') },
    ]);
    prisma.dayProgress.findMany.mockResolvedValue([
      {
        date: new Date('2026-06-20T00:00:00.000Z'),
        training_completed: true,
        exercises_completed: [],
        meals_completed: [],
        updated_at: new Date('2026-06-20T09:00:00.000Z'),
      },
    ]);

    const result = await service.recalculateClient('client-1', {
      asOf: new Date('2026-06-20T12:00:00.000Z'),
    });

    expect(result.currentDays).toBe(0);
    expect(result.longestDays).toBe(8);
  });

  it('skips orphan assignments during historical recalculation', async () => {
    prisma.planAssignment.findMany.mockResolvedValue([
      { client_id: 'client-valid' },
      { client_id: 'client-orphan' },
    ]);
    prisma.user.findMany.mockResolvedValue([{ id: 'client-valid' }]);
    const recalculateSpy = jest
      .spyOn(service, 'recalculateClient')
      .mockResolvedValue({
        currentDays: 0,
        longestDays: 0,
        previousCurrentDays: 0,
        changed: false,
      });

    await expect(service.recalculateAllHistory()).resolves.toBe(1);

    expect(recalculateSpy).toHaveBeenCalledTimes(1);
    expect(recalculateSpy).toHaveBeenCalledWith(
      'client-valid',
      expect.objectContaining({ rebuildLongest: true }),
    );
  });
});
