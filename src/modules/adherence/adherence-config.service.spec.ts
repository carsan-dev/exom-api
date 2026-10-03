import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { AdherenceConfigService } from './adherence-config.service';

const values = {
  steps_goal: null,
  calorie_lower_percent: 10,
  calorie_upper_percent: 10,
  protein_min_percent: 90,
  steps_min_percent: 100,
  low_global_percent: 80,
};

describe('AdherenceConfigService', () => {
  const prisma = {
    user: { findUnique: jest.fn() },
    adherenceConfigEpoch: { findUnique: jest.fn() },
    $queryRaw: jest.fn(),
    adherenceConfigHead: {
      findUnique: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
    },
    adherenceConfigRevision: { findFirst: jest.fn(), create: jest.fn() },
    $transaction: jest.fn(),
  };
  let service: AdherenceConfigService;

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation(
      (callback: (tx: typeof prisma) => Promise<unknown>) => callback(prisma),
    );
    prisma.user.findUnique.mockResolvedValue({
      id: 'client',
      role: Role.CLIENT,
    });
    prisma.adherenceConfigHead.findUnique.mockResolvedValue(null);
    prisma.adherenceConfigEpoch.findUnique.mockResolvedValue({
      effective_date: new Date('2026-09-28T00:00:00.000Z'),
    });
    prisma.$queryRaw.mockResolvedValue([{ id: 'assignment' }]);
    prisma.adherenceConfigRevision.findFirst.mockResolvedValue(null);
    prisma.adherenceConfigHead.create.mockResolvedValue({ version: 1 });
    prisma.adherenceConfigHead.updateMany.mockResolvedValue({ count: 1 });
    prisma.adherenceConfigRevision.create.mockImplementation(
      ({ data }: { data: object }) => Promise.resolve(data),
    );
    service = new AdherenceConfigService(prisma as never);
  });

  it('returns current defaults without claiming an uncaptured historical date', async () => {
    const current = await service.get('admin', Role.ADMIN, 'client');
    expect(current).toMatchObject({
      version: 0,
      known: true,
      source: 'default',
      ...values,
    });
    const historical = await service.get(
      'admin',
      Role.ADMIN,
      'client',
      '2020-01-01',
    );
    expect(historical).toMatchObject({
      version: 0,
      known: false,
      source: 'uncaptured',
    });
    expect(historical).not.toHaveProperty('steps_goal');
  });

  it('keeps migration-date defaults available after the clock advances, never before migration', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-28T12:00:00.000Z'));
    try {
      expect(
        await service.get('admin', Role.ADMIN, 'client', '2026-09-27'),
      ).toMatchObject({ known: false, source: 'uncaptured' });
      jest.setSystemTime(new Date('2026-09-29T12:00:00.000Z'));
      expect(
        await service.get('admin', Role.ADMIN, 'client', '2026-09-28'),
      ).toMatchObject({ known: true, source: 'default', ...values });
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects non-clients and unassigned clients', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({
      id: 'client',
      role: Role.ADMIN,
    });
    await expect(
      service.get('admin', Role.ADMIN, 'client'),
    ).rejects.toBeInstanceOf(NotFoundException);
    prisma.$queryRaw.mockResolvedValueOnce([]);
    await expect(
      service.get('admin', Role.ADMIN, 'client'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects a revoked assignment inside the read transaction before reading configuration', async () => {
    // A revoked assignment must deny access before any configuration reads.
    prisma.$queryRaw.mockResolvedValueOnce([]);
    await expect(
      service.get('admin', Role.ADMIN, 'client'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.adherenceConfigHead.findUnique).not.toHaveBeenCalled();
    expect(prisma.adherenceConfigEpoch.findUnique).not.toHaveBeenCalled();
    expect(prisma.adherenceConfigRevision.findFirst).not.toHaveBeenCalled();
  });

  it('checks assignment under the write transaction lock before changing configuration', async () => {
    let inTransaction = false;
    prisma.$transaction.mockImplementationOnce(
      async (callback: (tx: typeof prisma) => Promise<unknown>) => {
        inTransaction = true;
        try {
          return await callback(prisma);
        } finally {
          inTransaction = false;
        }
      },
    );
    prisma.$queryRaw.mockImplementationOnce(() => {
      expect(inTransaction).toBe(true);
      return Promise.resolve([]);
    });
    await expect(
      service.update('admin', Role.ADMIN, 'client', {
        ...values,
        effective_date: '2099-01-01',
        expected_version: 0,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.adherenceConfigHead.create).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('rejects tomorrow when the final check is within the transaction budget of UTC midnight', async () => {
    class NearMidnightService extends AdherenceConfigService {
      protected override utcInstant(): Date {
        return new Date('2098-12-31T23:59:45.000Z');
      }
    }
    const nearMidnight = new NearMidnightService(prisma as never);
    await expect(
      nearMidnight.update('admin', Role.ADMIN, 'client', {
        ...values,
        effective_date: '2099-01-01',
        expected_version: 0,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.adherenceConfigRevision.create).not.toHaveBeenCalled();
  });

  it('accepts a future-at-submission effective date that becomes provisional today while waiting', async () => {
    let instant = new Date('2098-12-31T23:59:00.000Z');
    class ControlledClockService extends AdherenceConfigService {
      protected override utcInstant(): Date {
        return instant;
      }
    }
    prisma.$transaction.mockImplementationOnce(
      async (callback: (tx: typeof prisma) => Promise<unknown>) => {
        instant = new Date('2099-01-01T00:00:01.000Z');
        return callback(prisma);
      },
    );
    await expect(
      new ControlledClockService(prisma as never).update(
        'admin',
        Role.ADMIN,
        'client',
        {
          ...values,
          effective_date: '2099-01-01',
          expected_version: 0,
        },
      ),
    ).resolves.toMatchObject({ version: 1, effective_date: '2099-01-01' });
    expect(prisma.adherenceConfigRevision.create).toHaveBeenCalledTimes(1);
  });

  it('rejects a date that becomes closed while waiting, without appending', async () => {
    let instant = new Date('2098-12-31T23:59:00.000Z');
    class ControlledClockService extends AdherenceConfigService {
      protected override utcInstant(): Date {
        return instant;
      }
    }
    prisma.$transaction.mockImplementationOnce(
      async (callback: (tx: typeof prisma) => Promise<unknown>) => {
        instant = new Date('2099-01-02T00:00:01.000Z');
        return callback(prisma);
      },
    );
    await expect(
      new ControlledClockService(prisma as never).update(
        'admin',
        Role.ADMIN,
        'client',
        {
          ...values,
          effective_date: '2099-01-01',
          expected_version: 0,
        },
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.adherenceConfigRevision.create).not.toHaveBeenCalled();
  });

  it('rejects closed-day edits and stale concurrent versions without appending revisions', async () => {
    await expect(
      service.update('admin', Role.ADMIN, 'client', {
        ...values,
        effective_date: '2020-01-01',
        expected_version: 0,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.adherenceConfigRevision.create).not.toHaveBeenCalled();

    prisma.adherenceConfigHead.findUnique.mockResolvedValue({ version: 2 });
    await expect(
      service.update('admin', Role.ADMIN, 'client', {
        ...values,
        effective_date: '2099-01-01',
        expected_version: 1,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.adherenceConfigRevision.create).not.toHaveBeenCalled();
  });

  it('refuses a concurrent compare-and-swap loser without appending', async () => {
    prisma.adherenceConfigHead.findUnique.mockResolvedValue({ version: 1 });
    prisma.adherenceConfigHead.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      service.update('admin', Role.ADMIN, 'client', {
        ...values,
        effective_date: '2099-01-01',
        expected_version: 1,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.adherenceConfigRevision.create).not.toHaveBeenCalled();
  });

  it('serializes a versioned append and rejects an earlier insertion than an existing future revision', async () => {
    const input = {
      ...values,
      steps_goal: 8500,
      effective_date: '2099-01-01',
      expected_version: 0,
    };
    expect(
      await service.update('admin', Role.ADMIN, 'client', input),
    ).toMatchObject({ version: 1, known: true, steps_goal: 8500 });
    expect(prisma.adherenceConfigHead.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: { client_id: 'client', version: 1 } }),
    );
    expect(prisma.adherenceConfigRevision.create).toHaveBeenCalledTimes(1);
    prisma.adherenceConfigHead.findUnique.mockResolvedValue({ version: 1 });
    prisma.adherenceConfigRevision.findFirst.mockResolvedValue({
      effective_date: new Date('2099-01-01'),
    });
    await expect(
      service.update('admin', Role.ADMIN, 'client', {
        ...input,
        effective_date: '2098-01-01',
        expected_version: 1,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
