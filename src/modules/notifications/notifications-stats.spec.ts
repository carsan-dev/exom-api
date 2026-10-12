import { NotificationStatus, Prisma } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PrismaService } from '../../prisma/prisma.service';
import type { JobsService } from '../jobs/jobs.service';
import { FeedbackStatsQueryDto } from '../feedback/dto/admin-feedback-query.dto';
import { NotificationStatsQueryDto } from './dto/notification-query.dto';
import { NotificationsService } from './notifications.service';

type CountArgs = [{ where: Prisma.NotificationWhereInput }];

describe('NotificationsService.getStats', () => {
  let count: jest.Mock<Promise<number>, CountArgs>;
  let service: NotificationsService;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-12T15:30:00.000Z'));
    count = jest.fn<Promise<number>, CountArgs>().mockResolvedValue(0);
    service = new NotificationsService(
      { notification: { count } } as unknown as PrismaService,
      {} as JobsService,
    );
  });

  afterEach(() => jest.useRealTimers());

  const today = new Date('2026-10-12T00:00:00.000Z');

  it('keeps the no-params response and queries identical', async () => {
    count
      .mockResolvedValueOnce(7)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(1);
    await expect(service.getStats('admin-1')).resolves.toEqual({
      total: 7,
      today: 2,
      failed: 1,
    });
    expect(count.mock.calls).toEqual([
      [{ where: { sender_id: 'admin-1' } }],
      [
        {
          where: {
            sender_id: 'admin-1',
            created_at: { gte: today },
            status: NotificationStatus.SENT,
          },
        },
      ],
      [{ where: { sender_id: 'admin-1', status: NotificationStatus.FAILED } }],
    ]);
  });

  it('applies period (inclusive to) and recipient filters within the sender scope', async () => {
    await service.getStats('admin-1', {
      from: '2026-10-01',
      to: '2026-10-10',
      recipient_id: 'client-1',
    });
    const created_at = {
      gte: new Date('2026-10-01T00:00:00.000Z'),
      lt: new Date('2026-10-11T00:00:00.000Z'),
    };
    expect(count.mock.calls).toEqual([
      [
        {
          where: { sender_id: 'admin-1', recipient_id: 'client-1', created_at },
        },
      ],
      [
        {
          where: {
            sender_id: 'admin-1',
            recipient_id: 'client-1',
            created_at: { gte: today },
            status: NotificationStatus.SENT,
          },
        },
      ],
      [
        {
          where: {
            sender_id: 'admin-1',
            recipient_id: 'client-1',
            created_at,
            status: NotificationStatus.FAILED,
          },
        },
      ],
    ]);
  });
});

describe('stats query DTO validation', () => {
  async function invalidProps(
    cls: typeof NotificationStatsQueryDto | typeof FeedbackStatsQueryDto,
    query: Record<string, string>,
  ) {
    return (await validate(plainToInstance(cls, query))).map((e) => e.property);
  }

  it('rejects invalid dates, from>to and malformed recipient ids', async () => {
    await expect(
      invalidProps(NotificationStatsQueryDto, { from: '2026-02-29' }),
    ).resolves.toEqual(['from']);
    await expect(
      invalidProps(FeedbackStatsQueryDto, {
        from: '2026-10-02',
        to: '2026-10-01',
      }),
    ).resolves.toEqual(['to']);
    await expect(
      invalidProps(NotificationStatsQueryDto, { recipient_id: 'nope' }),
    ).resolves.toEqual(['recipient_id']);
    await expect(
      invalidProps(FeedbackStatsQueryDto, {
        client_id: 'client-1',
        from: '2026-10-01',
        to: '2026-10-01',
      }),
    ).resolves.toEqual([]);
  });
});
