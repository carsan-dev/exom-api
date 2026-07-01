import { AutoAssignmentMaterializerService } from './auto-assignment-materializer.service';

describe('AutoAssignmentMaterializerService', () => {
  const prisma = {
    autoAssignmentRule: { findMany: jest.fn() },
    planAssignment: { findMany: jest.fn(), createMany: jest.fn() },
  };
  const service = new AutoAssignmentMaterializerService(prisma as never);

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.planAssignment.createMany.mockResolvedValue({ count: 0 });
  });

  it('materializes an indefinite Thursday rule in a later month without replacing occupied dates', async () => {
    prisma.autoAssignmentRule.findMany.mockResolvedValue([
      {
        id: 'rule-1',
        admin_id: 'admin-1',
        starts_on: new Date('2026-06-01T00:00:00.000Z'),
        ends_on: null,
        days: [{
          weekday: 4,
          training_id: 'training-rule',
          diet_id: null,
          is_rest_day: false,
        }],
      },
    ]);
    prisma.planAssignment.findMany.mockResolvedValue([
      { date: new Date('2026-07-09T00:00:00.000Z') },
    ]);
    const dates = Array.from({ length: 31 }, (_, index) =>
      new Date(Date.UTC(2026, 6, index + 1)),
    );

    await service.materialize('client-1', {
      start: dates[0],
      end: dates[30],
      dates,
    });

    expect(prisma.autoAssignmentRule.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ ends_on: null }, { ends_on: { gte: dates[0] } }],
        }),
      }),
    );
    const created = prisma.planAssignment.createMany.mock.calls[0][0].data;
    expect(created.map((item: { date: Date }) => item.date.toISOString().slice(0, 10)))
      .toEqual(['2026-07-02', '2026-07-16', '2026-07-23', '2026-07-30']);
    expect(created).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ date: new Date('2026-07-09T00:00:00.000Z') }),
    ]));
    expect(prisma.planAssignment.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    );
  });
});
