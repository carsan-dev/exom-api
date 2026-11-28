import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool, type PoolClient } from 'pg';
import { PrismaService } from '../../prisma/prisma.service';
import { UploadsService } from '../uploads/uploads.service';
import { ClientDeletionService } from '../client-deletion/client-deletion.service';
import { ProfileService } from './profile.service';
import { MarkOnboardingDto } from './dto/mark-onboarding.dto';
import {
  databaseUrl,
  verifyDatabase,
} from '../../../scripts/test-database.cjs';

type Mark = {
  onboarding_completed_at: Date | null;
  onboarding_outcome: string | null;
};

const BACKFILL_SQL = readFileSync(
  resolve(__dirname, '../../../scripts/sql/onboarding-state/backfill.sql'),
  'utf8',
);
const REPETITIONS = 20;

// OP-API-04 and OP-MIG-07: first-write-wins under real PostgreSQL row locks.
// A third connection holds the profile row with SELECT ... FOR UPDATE until
// every contender is observed waiting on a lock, then releases it.
const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;
describeDb('profile onboarding mark PostgreSQL interleaving', () => {
  let pool: Pool;
  let prisma: PrismaClient;
  let service: ProfileService;
  const owners: string[] = [];

  beforeAll(async () => {
    await verifyDatabase();
    pool = new Pool({ connectionString: databaseUrl(), max: 8 });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    const module = await Test.createTestingModule({
      providers: [
        ProfileService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: new ConfigService() },
        { provide: UploadsService, useValue: {} },
        { provide: ClientDeletionService, useValue: {} },
      ],
    }).compile();
    service = module.get(ProfileService);
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.user.deleteMany({ where: { id: { in: owners } } });
      await prisma.$disconnect();
    }
    if (pool) await pool.end();
  });

  async function client(fcmToken: string | null = null) {
    const id = randomUUID();
    owners.push(id);
    await prisma.user.create({
      data: {
        id,
        firebase_uid: id,
        email: `${id}@example.test`,
        role: 'CLIENT',
        fcm_token: fcmToken,
        profile: { create: { first_name: 'Race', last_name: 'Fixture' } },
      },
    });
    return id;
  }

  // Read through Prisma: node-pg would parse TIMESTAMP(3) in the local zone,
  // while Prisma (service and expectations) treats it as UTC.
  function persisted(userId: string): Promise<Mark> {
    return prisma.profile.findUniqueOrThrow({
      where: { user_id: userId },
      select: { onboarding_completed_at: true, onboarding_outcome: true },
    });
  }

  async function lockWaiters(observer: PoolClient): Promise<number> {
    // The observer polls inside its own transaction: drop the frozen
    // pg_stat_activity snapshot so each poll sees the current waiters.
    await observer.query('SELECT pg_stat_clear_snapshot()');
    const { rows } = await observer.query<{ waiting: number }>(
      `SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND query ILIKE '%profiles%'`,
    );
    return rows[0].waiting;
  }

  async function waitForWaiters(observer: PoolClient, expected: number) {
    for (let attempt = 0; attempt < 500; attempt++) {
      if ((await lockWaiters(observer)) >= expected) return;
      await new Promise((done) => setTimeout(done, 10));
    }
    throw Error(`Expected ${expected} lock waiters on profiles`);
  }

  async function holdRow(userId: string) {
    const locker = await pool.connect();
    await locker.query('BEGIN');
    await locker.query(
      'SELECT id FROM profiles WHERE user_id = $1 FOR UPDATE',
      [userId],
    );
    return locker;
  }

  function mark(userId: string, outcome?: MarkOnboardingDto['outcome']) {
    const dto = new MarkOnboardingDto();
    if (outcome !== undefined) dto.outcome = outcome;
    return service.markOnboarding(userId, dto);
  }

  function expectSameMark(response: Mark, stored: Mark) {
    expect(response.onboarding_outcome).toBe(stored.onboarding_outcome);
    expect(response.onboarding_completed_at?.getTime()).toBe(
      stored.onboarding_completed_at?.getTime(),
    );
  }

  it(`forced interleaving of COMPLETED and SKIPPED keeps one winner (${REPETITIONS} runs)`, async () => {
    for (let run = 0; run < REPETITIONS; run++) {
      const userId = await client();
      const locker = await holdRow(userId);
      let pending: Promise<Mark>[] = [];
      try {
        pending = [mark(userId, 'COMPLETED')];
        await waitForWaiters(locker, 1);
        pending.push(mark(userId, 'SKIPPED'));
        await waitForWaiters(locker, 2);
        await locker.query('COMMIT');
      } finally {
        await locker.query('ROLLBACK').catch(() => undefined);
        locker.release();
      }
      const [first, second] = await Promise.all(pending);
      const stored = await persisted(userId);
      expect(stored.onboarding_completed_at).not.toBeNull();
      expect(['COMPLETED', 'SKIPPED']).toContain(stored.onboarding_outcome);
      expectSameMark(first, stored);
      expectSameMark(second, stored);
    }
  }, 120000);

  it(`unforced simultaneous marks agree on the persisted value (${REPETITIONS} runs)`, async () => {
    for (let run = 0; run < REPETITIONS; run++) {
      const userId = await client();
      const responses = await Promise.all([
        mark(userId, 'COMPLETED'),
        mark(userId, 'SKIPPED'),
        mark(userId),
      ]);
      const stored = await persisted(userId);
      expect(stored.onboarding_completed_at).not.toBeNull();
      for (const response of responses) expectSameMark(response, stored);
    }
  }, 120000);

  it('backfill waiting behind a POST never overwrites its outcome or date', async () => {
    const userId = await client('fcm-race-token');
    const locker = await holdRow(userId);
    const backfillConnection = await pool.connect();
    const post = mark(userId, 'SKIPPED');
    // Observed later with await; avoid an unhandled rejection if the wait throws.
    post.catch(() => undefined);
    let backfill: Promise<unknown> = Promise.resolve();
    try {
      await waitForWaiters(locker, 1);
      backfill = backfillConnection.query(BACKFILL_SQL);
      await waitForWaiters(locker, 2);
      await locker.query('COMMIT');
    } finally {
      await locker.query('ROLLBACK').catch(() => undefined);
      locker.release();
    }
    try {
      const response = await post;
      await backfill;
      const stored = await persisted(userId);
      expect(stored.onboarding_outcome).toBe('SKIPPED');
      expectSameMark(response, stored);
      // A second backfill finds nothing left to mark for this client.
      await backfillConnection.query(BACKFILL_SQL);
      expect(await persisted(userId)).toEqual(stored);
    } finally {
      backfillConnection.release();
    }
  }, 30000);

  it('a POST waiting behind the backfill keeps the backfill date and NULL outcome', async () => {
    const userId = await client('fcm-race-token');
    const locker = await holdRow(userId);
    const backfillConnection = await pool.connect();
    const backfill = backfillConnection.query(BACKFILL_SQL);
    let post: Promise<Mark> | null = null;
    try {
      await waitForWaiters(locker, 1);
      post = mark(userId, 'COMPLETED');
      await waitForWaiters(locker, 2);
      await locker.query('COMMIT');
    } finally {
      await locker.query('ROLLBACK').catch(() => undefined);
      locker.release();
    }
    try {
      await backfill;
      if (post === null) throw Error('POST was not started');
      const response = await post;
      const stored = await persisted(userId);
      expect(stored.onboarding_completed_at).not.toBeNull();
      expect(stored.onboarding_outcome).toBeNull();
      expectSameMark(response, stored);
    } finally {
      backfillConnection.release();
    }
  }, 30000);
});
