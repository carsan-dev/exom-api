import { PrismaService } from '../../prisma/prisma.service';
import { DietsService } from './diets.service';
import type { AutoAssignmentMaterializerService } from '../assignments/auto-assignment-materializer.service';

describe('DietsService.findWeek', () => {
  const findMany = jest.fn();
  const findUnique = jest.fn();
  const reconcile = jest.fn();
  const service = new DietsService(
    { planAssignment: { findMany, findUnique } } as unknown as PrismaService,
    {} as never,
    { reconcile } as unknown as AutoAssignmentMaterializerService,
  );

  beforeEach(() => {
    findMany.mockReset();
    findUnique.mockReset();
    reconcile.mockReset().mockResolvedValue(undefined);
  });

  it('reconciles a directly requested day before reading its diet', async () => {
    findUnique.mockResolvedValue(null);

    await expect(
      service.findToday('client-1', new Date('2026-06-18T12:00:00.000Z')),
    ).resolves.toBeNull();

    const target = new Date('2026-06-18T00:00:00.000Z');
    expect(reconcile).toHaveBeenCalledWith('client-1', {
      start: target,
      end: target,
      dates: [target],
    });
    expect(reconcile.mock.invocationCallOrder[0]).toBeLessThan(
      findUnique.mock.invocationCallOrder[0],
    );
  });

  it('normalizes the requested date to Monday and returns seven days', async () => {
    findMany.mockResolvedValue([
      {
        date: new Date('2026-06-17T00:00:00.000Z'),
        diet: { id: 'diet-1', name: 'Plan', tags: ['private'], meals: [] },
      },
    ]);

    const result = await service.findWeek(
      'client-1',
      new Date('2026-06-18T00:00:00.000Z'),
    );

    expect(result.week_start).toBe('2026-06-15');
    expect(result.week_end).toBe('2026-06-21');
    expect(result.days).toHaveLength(7);
    expect(result.days[2]).toEqual({
      date: '2026-06-17',
      diet: { id: 'diet-1', name: 'Plan', meals: [] },
    });
    expect(result.days[0]).toEqual({ date: '2026-06-15', diet: null });
    expect(reconcile).toHaveBeenCalledWith('client-1', {
      start: new Date('2026-06-15T00:00:00.000Z'),
      end: new Date('2026-06-21T00:00:00.000Z'),
      dates: Array.from(
        { length: 7 },
        (_, offset) => new Date(Date.UTC(2026, 5, 15 + offset)),
      ),
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ client_id: 'client-1' }),
        orderBy: { date: 'asc' },
      }),
    );
  });

  it('returns an empty week when no diets are assigned', async () => {
    findMany.mockResolvedValue([]);

    const result = await service.findWeek(
      'client-1',
      new Date('2026-06-21T00:00:00.000Z'),
    );

    expect(result.week_start).toBe('2026-06-15');
    expect(result.days.every((day) => day.diet === null)).toBe(true);
  });

  it('returns every day in a leap-year February with UTC boundaries', async () => {
    findMany.mockResolvedValue([
      {
        date: new Date('2028-02-29T00:00:00.000Z'),
        diet: { id: 'diet-leap', name: 'Leap', tags: [], meals: [] },
      },
    ]);
    const result = await service.findMonth('client-1', 2028, 2);
    expect(result.month_start).toBe('2028-02-01');
    expect(result.month_end).toBe('2028-02-29');
    expect(result.days).toHaveLength(29);
    expect(result.days[28].diet?.id).toBe('diet-leap');
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          date: {
            gte: new Date('2028-02-01T00:00:00.000Z'),
            lte: new Date('2028-02-29T00:00:00.000Z'),
          },
        }),
      }),
    );
  });

  it('returns all empty natural days for an unassigned month', async () => {
    findMany.mockResolvedValue([]);
    const result = await service.findMonth('client-1', 2026, 7);
    expect(result.days).toHaveLength(31);
    expect(result.days.every((day) => day.diet === null)).toBe(true);
  });
});
