import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  FeedbackStatus,
  MediaType,
  PrismaClient,
  RecapStatus,
  Role,
} from '@prisma/client';
import { Pool } from 'pg';
import { PrismaService } from '../prisma/prisma.service';
import type { NotificationsService } from '../modules/notifications/notifications.service';
import type { UploadsService } from '../modules/uploads/uploads.service';
import { FeedbackService } from '../modules/feedback/feedback.service';
import { RecapsService } from '../modules/recaps/recaps.service';

// Executes the raw review-duration aggregates on real PostgreSQL. Only fixtures
// created here are read (fresh admins or explicit client_id) and removed.
const url = process.env.TEST_DATABASE_URL ?? '';
const describeWithDatabase = url ? describe : describe.skip;

const at = (value: string) => new Date(`${value}Z`);
const HOUR = 3600;
// Durations per fixture (seconds), shared by recaps and feedback.
const OWN_SAME_DAY = HOUR; // reviewed 2098-03-01
const OWN_TO_DAY = 2 * 86_400 + 86_399.999; // reviewed 2098-03-04 23:59:59.999
const OWN_NEXT_DAY = 12 * HOUR; // reviewed 2098-03-05 00:00:00.000
const OTHER_ADMIN = HOUR / 2;
const INACTIVE = 2 * HOUR;
const NON_CLIENT = 600;

describeWithDatabase('Review duration stats (PostgreSQL)', () => {
  const tag = randomUUID();
  const id = (name: string) => `review-stats-${name}-${tag}`;
  const adminA = id('admin-a');
  const adminB = id('admin-b');
  const superAdmin = id('super');
  const client1 = id('client-1');
  const client2 = id('client-2');
  const client3 = id('client-3');
  const staffSubject = id('staff-subject');
  const userIds = [
    adminA,
    adminB,
    superAdmin,
    client1,
    client2,
    client3,
    staffSubject,
  ];
  let pool: Pool;
  let prisma: PrismaClient;
  let recaps: RecapsService;
  let feedback: FeedbackService;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    const users: Array<[string, Role]> = [
      [adminA, Role.ADMIN],
      [adminB, Role.ADMIN],
      [superAdmin, Role.SUPER_ADMIN],
      [client1, Role.CLIENT],
      [client2, Role.CLIENT],
      [client3, Role.CLIENT],
      [staffSubject, Role.ADMIN],
    ];
    await prisma.user.createMany({
      data: users.map(([userId, role]) => ({
        id: userId,
        email: `${userId}@example.test`,
        firebase_uid: userId,
        role,
      })),
    });
    await prisma.adminClientAssignment.createMany({
      data: [
        { admin_id: adminA, client_id: client1, is_active: true },
        { admin_id: adminB, client_id: client2, is_active: true },
        { admin_id: adminA, client_id: client3, is_active: false },
      ],
    });

    const reviewed = (
      clientId: string,
      week: string,
      start: string,
      seconds: number,
    ) => ({
      client_id: clientId,
      week_start_date: at(`${week}T00:00:00.000`),
      week_end_date: at(`${week}T00:00:00.000`),
      status: RecapStatus.REVIEWED,
      submitted_at: at(start),
      reviewed_at: new Date(at(start).getTime() + Math.round(seconds * 1000)),
    });
    await prisma.weeklyRecap.createMany({
      data: [
        reviewed(
          client1,
          '2098-01-05',
          '2098-03-01T10:00:00.000',
          OWN_SAME_DAY,
        ),
        reviewed(client1, '2098-01-12', '2098-03-02T00:00:00.000', OWN_TO_DAY),
        reviewed(
          client1,
          '2098-01-19',
          '2098-03-04T12:00:00.000',
          OWN_NEXT_DAY,
        ),
        {
          client_id: client1,
          week_start_date: at('2098-01-26T00:00:00.000'),
          week_end_date: at('2098-02-01T00:00:00.000'),
          status: RecapStatus.SUBMITTED,
          submitted_at: at('2098-03-03T09:00:00.000'),
          archived_at: at('2098-03-03T10:00:00.000'),
        },
        {
          client_id: client1,
          week_start_date: at('2098-02-02T00:00:00.000'),
          week_end_date: at('2098-02-08T00:00:00.000'),
          status: RecapStatus.DRAFT,
        },
        reviewed(client2, '2098-01-05', '2098-03-01T10:00:00.000', OTHER_ADMIN),
        reviewed(client3, '2098-01-05', '2098-03-01T10:00:00.000', INACTIVE),
        reviewed(
          staffSubject,
          '2098-01-05',
          '2098-03-01T10:00:00.000',
          NON_CLIENT,
        ),
      ],
    });

    const media = (
      clientId: string,
      created: string,
      seconds: number | null,
    ) => ({
      client_id: clientId,
      media_type: MediaType.VIDEO,
      created_at: at(created),
      status:
        seconds === null ? FeedbackStatus.PENDING : FeedbackStatus.REVIEWED,
      reviewed_at:
        seconds === null
          ? null
          : new Date(at(created).getTime() + Math.round(seconds * 1000)),
    });
    await prisma.feedbackMedia.createMany({
      data: [
        media(client1, '2098-03-01T10:00:00.000', OWN_SAME_DAY),
        media(client1, '2098-03-02T00:00:00.000', OWN_TO_DAY),
        media(client1, '2098-03-04T12:00:00.000', OWN_NEXT_DAY),
        media(client1, '2098-03-03T09:00:00.000', null),
        media(client2, '2098-03-01T10:00:00.000', OTHER_ADMIN),
        media(client3, '2098-03-01T10:00:00.000', INACTIVE),
        media(staffSubject, '2098-03-01T10:00:00.000', NON_CLIENT),
      ],
    });

    const notifications = {} as unknown as NotificationsService;
    recaps = new RecapsService(
      prisma as unknown as PrismaService,
      notifications,
    );
    feedback = new FeedbackService(
      prisma as unknown as PrismaService,
      notifications,
      {} as unknown as UploadsService,
    );
  });

  afterAll(async () => {
    // Recaps, feedback and assignments cascade from these fixture users only.
    if (prisma) {
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await prisma.$disconnect();
    }
    if (pool) await pool.end();
  });

  const average = (...seconds: number[]) =>
    seconds.reduce((sum, value) => sum + value, 0) / seconds.length;
  const empty = { avg_review_seconds: null, reviewed_in_period: 0 };

  describe('recaps', () => {
    it('keeps previous counts and adds review duration without params', async () => {
      const stats = await recaps.getStats(adminA, Role.ADMIN);
      expect(stats).toEqual({
        total: 4,
        submitted: 1,
        reviewed: 3,
        archived: 1,
        reviewed_in_period: 3,
        avg_review_seconds: expect.any(Number) as number,
      });
      expect(stats.avg_review_seconds).toBeCloseTo(
        average(OWN_SAME_DAY, OWN_TO_DAY, OWN_NEXT_DAY),
        3,
      );
    });

    it('includes reviews on the to day and excludes the next day', async () => {
      const stats = await recaps.getStats(adminA, Role.ADMIN, {
        from: '2098-03-01',
        to: '2098-03-04',
      });
      expect(stats.reviewed_in_period).toBe(2);
      expect(stats.avg_review_seconds).toBeCloseTo(
        average(OWN_SAME_DAY, OWN_TO_DAY),
        3,
      );
      // Counts filter submitted_at; all four non-draft recaps were submitted.
      expect(stats).toMatchObject({ total: 4, submitted: 1, reviewed: 3 });

      const nextDay = await recaps.getStats(adminA, Role.ADMIN, {
        from: '2098-03-05',
        to: '2098-03-05',
      });
      expect(nextDay.reviewed_in_period).toBe(1);
      expect(nextDay.avg_review_seconds).toBeCloseTo(OWN_NEXT_DAY, 3);
      expect(nextDay).toMatchObject({ total: 0, submitted: 0, reviewed: 0 });
    });

    it('returns nothing for another admin client or an inactive assignment', async () => {
      for (const clientId of [client2, client3]) {
        await expect(
          recaps.getStats(adminA, Role.ADMIN, { client_id: clientId }),
        ).resolves.toEqual({
          total: 0,
          submitted: 0,
          reviewed: 0,
          archived: 0,
          ...empty,
        });
      }
      const other = await recaps.getStats(adminB, Role.ADMIN);
      expect(other).toMatchObject({ total: 1, reviewed_in_period: 1 });
      expect(other.avg_review_seconds).toBeCloseTo(OTHER_ADMIN, 3);
    });

    it('limits SUPER_ADMIN to CLIENT-role users', async () => {
      const own = await recaps.getStats(superAdmin, Role.SUPER_ADMIN, {
        client_id: client3,
      });
      expect(own).toMatchObject({ total: 1, reviewed_in_period: 1 });
      expect(own.avg_review_seconds).toBeCloseTo(INACTIVE, 3);
      await expect(
        recaps.getStats(superAdmin, Role.SUPER_ADMIN, {
          client_id: staffSubject,
        }),
      ).resolves.toEqual({
        total: 0,
        submitted: 0,
        reviewed: 0,
        archived: 0,
        ...empty,
      });
    });
  });

  describe('feedback', () => {
    it('keeps previous counts and adds review duration without params', async () => {
      const stats = await feedback.getStats(adminA, Role.ADMIN);
      expect(stats).toEqual({
        total: 4,
        pending: 1,
        reviewed: 3,
        reviewed_in_period: 3,
        avg_review_seconds: expect.any(Number) as number,
      });
      expect(stats.avg_review_seconds).toBeCloseTo(
        average(OWN_SAME_DAY, OWN_TO_DAY, OWN_NEXT_DAY),
        3,
      );
    });

    it('includes reviews on the to day and excludes the next day', async () => {
      const stats = await feedback.getStats(adminA, Role.ADMIN, {
        from: '2098-03-01',
        to: '2098-03-04',
      });
      expect(stats.reviewed_in_period).toBe(2);
      expect(stats.avg_review_seconds).toBeCloseTo(
        average(OWN_SAME_DAY, OWN_TO_DAY),
        3,
      );
      expect(stats).toMatchObject({ total: 4, pending: 1, reviewed: 3 });

      const nextDay = await feedback.getStats(adminA, Role.ADMIN, {
        from: '2098-03-05',
        to: '2098-03-05',
      });
      expect(nextDay.reviewed_in_period).toBe(1);
      expect(nextDay.avg_review_seconds).toBeCloseTo(OWN_NEXT_DAY, 3);
      expect(nextDay).toMatchObject({ total: 0, pending: 0, reviewed: 0 });
    });

    it('returns nothing for another admin client or an inactive assignment', async () => {
      for (const clientId of [client2, client3]) {
        await expect(
          feedback.getStats(adminA, Role.ADMIN, { client_id: clientId }),
        ).resolves.toEqual({ total: 0, pending: 0, reviewed: 0, ...empty });
      }
      const other = await feedback.getStats(adminB, Role.ADMIN);
      expect(other).toMatchObject({ total: 1, reviewed_in_period: 1 });
      expect(other.avg_review_seconds).toBeCloseTo(OTHER_ADMIN, 3);
    });

    it('limits SUPER_ADMIN to CLIENT-role users', async () => {
      const own = await feedback.getStats(superAdmin, Role.SUPER_ADMIN, {
        client_id: client3,
      });
      expect(own).toMatchObject({ total: 1, reviewed_in_period: 1 });
      expect(own.avg_review_seconds).toBeCloseTo(INACTIVE, 3);
      await expect(
        feedback.getStats(superAdmin, Role.SUPER_ADMIN, {
          client_id: staffSubject,
        }),
      ).resolves.toEqual({ total: 0, pending: 0, reviewed: 0, ...empty });
    });
  });
});
