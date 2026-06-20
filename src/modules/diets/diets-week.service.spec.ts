import { PrismaService } from '../../prisma/prisma.service';
import { DietsService } from './diets.service';

describe('DietsService.findWeek', () => {
  const findMany = jest.fn();
  const service = new DietsService({
    planAssignment: { findMany },
  } as unknown as PrismaService);

  beforeEach(() => findMany.mockReset());

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
});
