import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Role } from '@prisma/client';
import { Pool, PoolClient } from 'pg';
import { assertTestDatabase } from '../../../scripts/test-database.cjs';
import { PrismaService } from '../../prisma/prisma.service';
import { AdherenceConfigService } from './adherence-config.service';

const url = process.env.TEST_DATABASE_URL;
const values = {
  steps_goal: 8000,
  calorie_lower_percent: 10,
  calorie_upper_percent: 10,
  protein_min_percent: 90,
  steps_min_percent: 100,
  low_global_percent: 80,
};

(url ? describe : describe.skip)(
  'adherence configuration PostgreSQL interleaving',
  () => {
    const prefix = `adherence-${process.pid}-${Date.now()}`;
    const clientId = `${prefix}-client`;
    const adminId = `${prefix}-admin`;
    const superId = `${prefix}-super`;
    const ids = [clientId, adminId, superId];
    const future = (days: number) => {
      const date = new Date();
      date.setUTCDate(date.getUTCDate() + days);
      return date.toISOString().slice(0, 10);
    };
    let pool: Pool;
    let prisma: PrismaClient;
    let service: AdherenceConfigService;

    async function waitForBlocked(count: number) {
      for (let attempt = 0; attempt < 200; attempt++) {
        const result = await pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE application_name = $1 AND cardinality(pg_blocking_pids(pid)) > 0`,
          [prefix],
        );
        if (result.rows[0].n >= count) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`Expected ${count} blocked PostgreSQL connection(s)`);
    }

    async function rollbackAndRelease(connection: PoolClient) {
      await connection.query('ROLLBACK');
      connection.release();
    }

    beforeAll(async () => {
      pool = new Pool({
        connectionString: url,
        application_name: prefix,
        max: 8,
      });
      await assertTestDatabase(pool);
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
      service = new AdherenceConfigService(prisma as PrismaService);
      await prisma.user.createMany({
        data: ids.map((id, index) => ({
          id,
          firebase_uid: id,
          email: `${id}@example.test`,
          role:
            index === 0
              ? Role.CLIENT
              : index === 1
                ? Role.ADMIN
                : Role.SUPER_ADMIN,
        })),
      });
      await prisma.adminClientAssignment.create({
        data: { admin_id: adminId, client_id: clientId },
      });
    });

    afterAll(async () => {
      if (prisma) {
        await prisma.user.deleteMany({ where: { id: { in: ids } } });
        await prisma.$disconnect();
      }
      await pool?.end();
    });

    it('serializes two same-version appends without a lost update or revision fork', async () => {
      // Seed a head so both contenders must encounter the same row lock.
      await service.update(superId, Role.SUPER_ADMIN, clientId, {
        ...values,
        expected_version: 0,
        effective_date: future(10),
      });
      const blocker = await pool.connect();
      await blocker.query('BEGIN');
      await blocker.query(
        'SELECT client_id FROM adherence_config_heads WHERE client_id=$1 FOR UPDATE',
        [clientId],
      );
      const first = service
        .update(superId, Role.SUPER_ADMIN, clientId, {
          ...values,
          steps_goal: 8100,
          expected_version: 1,
          effective_date: future(11),
        })
        .then(
          () => 'accepted',
          (error: unknown) => error,
        );
      const second = service
        .update(superId, Role.SUPER_ADMIN, clientId, {
          ...values,
          steps_goal: 8200,
          expected_version: 1,
          effective_date: future(12),
        })
        .then(
          () => 'accepted',
          (error: unknown) => error,
        );
      try {
        await waitForBlocked(2);
      } finally {
        await blocker.query('COMMIT');
        blocker.release();
      }
      const outcomes = await Promise.all([first, second]);
      expect(outcomes.filter((outcome) => outcome === 'accepted')).toHaveLength(
        1,
      );
      expect(
        outcomes.filter((outcome) => outcome instanceof ConflictException),
      ).toHaveLength(1);
      const head = await prisma.adherenceConfigHead.findUniqueOrThrow({
        where: { client_id: clientId },
      });
      const revisions = await prisma.adherenceConfigRevision.findMany({
        where: { client_id: clientId },
        orderBy: { version: 'asc' },
      });
      expect(head.version).toBe(2);
      expect(revisions.map((revision) => revision.version)).toEqual([1, 2]);
      expect([8100, 8200]).toContain(revisions[1].steps_goal);
    }, 15000);

    it('rejects a write waiting behind assignment revocation', async () => {
      const blocker = await pool.connect();
      await blocker.query('BEGIN');
      await blocker.query(
        'SELECT id FROM admin_client_assignments WHERE admin_id=$1 AND client_id=$2 FOR UPDATE',
        [adminId, clientId],
      );
      const writing = service
        .update(adminId, Role.ADMIN, clientId, {
          ...values,
          expected_version: 2,
          effective_date: future(13),
        })
        .then(
          () => 'accepted',
          (error: unknown) => error,
        );
      try {
        await waitForBlocked(1);
        await blocker.query(
          'UPDATE admin_client_assignments SET is_active=false WHERE admin_id=$1 AND client_id=$2',
          [adminId, clientId],
        );
        await blocker.query('COMMIT');
      } finally {
        await rollbackAndRelease(blocker);
      }
      expect(await writing).toBeInstanceOf(ForbiddenException);
      expect(
        (
          await prisma.adherenceConfigHead.findUniqueOrThrow({
            where: { client_id: clientId },
          })
        ).version,
      ).toBe(2);
      await prisma.adminClientAssignment.updateMany({
        where: { admin_id: adminId, client_id: clientId },
        data: { is_active: true },
      });
    }, 15000);

    it('makes revocation wait behind a configuration writer holding assignment lock', async () => {
      const blocker = await pool.connect();
      const revoker = await pool.connect();
      await blocker.query('BEGIN');
      await blocker.query(
        'SELECT client_id FROM adherence_config_heads WHERE client_id=$1 FOR UPDATE',
        [clientId],
      );
      const writing = service.update(adminId, Role.ADMIN, clientId, {
        ...values,
        expected_version: 2,
        effective_date: future(14),
      });
      try {
        await waitForBlocked(1); // Writer acquired assignment lock before waiting on head.
        await revoker.query('BEGIN');
        const revoking = revoker.query(
          'UPDATE admin_client_assignments SET is_active=false WHERE admin_id=$1 AND client_id=$2',
          [adminId, clientId],
        );
        await waitForBlocked(2);
        await blocker.query('COMMIT');
        await expect(writing).resolves.toMatchObject({ version: 3 });
        await revoking;
        await revoker.query('COMMIT');
      } finally {
        await rollbackAndRelease(blocker);
        await rollbackAndRelease(revoker);
      }
      expect(
        (
          await prisma.adherenceConfigHead.findUniqueOrThrow({
            where: { client_id: clientId },
          })
        ).version,
      ).toBe(3);
    }, 15000);

    it('allows today after a real head-lock wait but rejects a closed day after a second wait', async () => {
      let clock = new Date('2098-12-31T12:00:00.000Z');
      class ControlledClockService extends AdherenceConfigService {
        protected override utcInstant(): Date {
          return clock;
        }
      }
      const clockedService = new ControlledClockService(
        prisma as PrismaService,
      );
      const before = await prisma.adherenceConfigRevision.count({
        where: { client_id: clientId },
      });
      const blockedUpdate = async (
        effective_date: string,
        expected_version: number,
        afterWait: Date,
      ) => {
        const blocker = await pool.connect();
        await blocker.query('BEGIN');
        await blocker.query(
          'SELECT client_id FROM adherence_config_heads WHERE client_id=$1 FOR UPDATE',
          [clientId],
        );
        const writing = clockedService
          .update(superId, Role.SUPER_ADMIN, clientId, {
            ...values,
            effective_date,
            expected_version,
          })
          .then(
            (result) => result,
            (error: unknown) => error,
          );
        try {
          try {
            await waitForBlocked(1);
          } catch (error) {
            const outcome = await writing;
            throw outcome instanceof Error ? outcome : error;
          }
          clock = afterWait;
        } finally {
          await rollbackAndRelease(blocker);
        }
        return writing;
      };
      const accepted = await blockedUpdate(
        '2099-01-01',
        3,
        new Date('2099-01-01T00:00:01.000Z'),
      );
      expect(accepted).toMatchObject({
        version: 4,
        effective_date: '2099-01-01',
      });
      expect(
        await prisma.adherenceConfigRevision.count({
          where: { client_id: clientId },
        }),
      ).toBe(before + 1);

      clock = new Date('2099-01-01T23:59:00.000Z');
      const nearMidnight = await blockedUpdate(
        '2099-01-02',
        4,
        new Date('2099-01-01T23:59:45.000Z'),
      );
      expect(nearMidnight).toBeInstanceOf(ConflictException);
      expect(
        await prisma.adherenceConfigRevision.count({
          where: { client_id: clientId },
        }),
      ).toBe(before + 1);

      clock = new Date('2099-01-01T12:00:00.000Z');
      const rejected = await blockedUpdate(
        '2099-01-02',
        4,
        new Date('2099-01-03T00:00:01.000Z'),
      );
      // The second request passed its submission check, but the day closes
      // before its transaction can acquire the configuration head lock.
      expect(rejected).toBeInstanceOf(ConflictException);
      expect(
        (
          await prisma.adherenceConfigHead.findUniqueOrThrow({
            where: { client_id: clientId },
          })
        ).version,
      ).toBe(4);
      expect(
        await prisma.adherenceConfigRevision.count({
          where: { client_id: clientId },
        }),
      ).toBe(before + 1);
    }, 15000);

    it('keeps a successful read protected while revocation waits for its assignment lock', async () => {
      await prisma.adminClientAssignment.updateMany({
        where: { admin_id: adminId, client_id: clientId },
        data: { is_active: true },
      });
      const blocker = await pool.connect();
      const revoker = await pool.connect();
      await blocker.query('BEGIN');
      await blocker.query(
        'LOCK TABLE adherence_config_heads IN ACCESS EXCLUSIVE MODE',
      );
      const reading = service.get(adminId, Role.ADMIN, clientId, future(14));
      try {
        await waitForBlocked(1); // Read holds the assignment lock while waiting on head.
        await revoker.query('BEGIN');
        const revoking = revoker.query(
          'UPDATE admin_client_assignments SET is_active=false WHERE admin_id=$1 AND client_id=$2',
          [adminId, clientId],
        );
        await waitForBlocked(2);
        await blocker.query('COMMIT');
        await expect(reading).resolves.toMatchObject({
          known: true,
          source: 'revision',
          steps_goal: 8000,
        });
        await revoking;
        await revoker.query('COMMIT');
      } finally {
        await rollbackAndRelease(blocker);
        await rollbackAndRelease(revoker);
        await prisma.adminClientAssignment.updateMany({
          where: { admin_id: adminId, client_id: clientId },
          data: { is_active: true },
        });
      }
      await expect(
        service.get(superId, Role.SUPER_ADMIN, clientId, future(14)),
      ).resolves.toMatchObject({ known: true, source: 'revision' });
      await expect(
        service.get(clientId, Role.CLIENT, clientId),
      ).rejects.toBeInstanceOf(ForbiddenException);
    }, 15000);

    it('does not reveal a revision when revocation commits before the read lock', async () => {
      await prisma.adminClientAssignment.updateMany({
        where: { admin_id: adminId, client_id: clientId },
        data: { is_active: true },
      });
      const blocker = await pool.connect();
      await blocker.query('BEGIN');
      await blocker.query(
        'UPDATE admin_client_assignments SET is_active=false WHERE admin_id=$1 AND client_id=$2',
        [adminId, clientId],
      );
      const reading = service
        .get(adminId, Role.ADMIN, clientId, future(14))
        .then(
          (value) => value,
          (error: unknown) => error,
        );
      try {
        await waitForBlocked(1);
        await blocker.query('COMMIT');
      } finally {
        await rollbackAndRelease(blocker);
      }
      expect(await reading).toBeInstanceOf(ConflictException);
      await prisma.adminClientAssignment.updateMany({
        where: { admin_id: adminId, client_id: clientId },
        data: { is_active: true },
      });
    }, 15000);

    it('rejects absent clients, inactive assignments and unauthorized roles without revisions', async () => {
      await prisma.adminClientAssignment.updateMany({
        where: { admin_id: adminId, client_id: clientId },
        data: { is_active: false },
      });
      const before = await prisma.adherenceConfigRevision.count({
        where: { client_id: clientId },
      });
      const input = {
        ...values,
        expected_version: 3,
        effective_date: future(15),
      };
      await expect(
        service.update(superId, Role.SUPER_ADMIN, `${prefix}-missing`, input),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        service.update(clientId, Role.CLIENT, clientId, input),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        service.update(adminId, Role.ADMIN, clientId, input),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(
        await prisma.adherenceConfigRevision.count({
          where: { client_id: clientId },
        }),
      ).toBe(before);
    }, 15000);
  },
);
