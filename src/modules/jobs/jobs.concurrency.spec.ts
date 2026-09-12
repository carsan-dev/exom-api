import { assertTestDatabase } from '../../../scripts/test-database.cjs';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { PrismaService } from '../../prisma/prisma.service';
import {
  JobsService,
  enqueueWork,
  WORK_MAX_ATTEMPTS,
  workContext,
} from './jobs.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationsSchedulerService } from '../notifications/notifications-scheduler.service';
import { AutoAssignmentMaterializerService } from '../assignments/auto-assignment-materializer.service';
import { boundedMap } from './bounded-map';
import { DomainWorkService } from './domain-work.service';
import { AchievementsService } from '../achievements/achievements.service';
import { ChallengesService } from '../challenges/challenges.service';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import { ExecutionContext, INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Server } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { Role } from '@prisma/client';
import { NotificationsController } from '../notifications/notifications.controller';
import { RolesGuard } from '../../common/guards/roles.guard';

const sendMock = jest.fn<Promise<string>, [{ data: Record<string, string> }]>();
jest.mock('firebase-admin', () => ({ messaging: () => ({ send: sendMock }) }));
const url = process.env.TEST_DATABASE_URL;
const integration = url ? describe : describe.skip;

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
integration('P6 PostgreSQL durable jobs and delivery', () => {
  let db: PrismaClient;
  let other: PrismaClient;
  let one: JobsService;
  let two: JobsService;
  let notifications: NotificationsService;
  let pools: Pool[];
  let isolated = false;
  const owner = `p6-owner-${process.pid}`;
  const prefix = `p6-test-${process.pid}:`;
  const key = (name: string) => prefix + name;
  const asService = (client: PrismaClient) => client as PrismaService;
  const work = (name: string) =>
    db.durableWork.findUniqueOrThrow({ where: { key: key(name) } });
  const due = (name: string) =>
    db.durableWork.update({
      where: { key: key(name) },
      data: { next_attempt_at: new Date(0), lease_until: null },
    });

  async function concurrentInserts(
    table: 'durable_work' | 'notifications',
    start: () => Promise<unknown>[],
  ) {
    const blocker = await pools[0].connect();
    await blocker.query('BEGIN');
    await blocker.query(
      table === 'durable_work'
        ? 'LOCK TABLE durable_work IN SHARE MODE'
        : 'LOCK TABLE notifications IN SHARE MODE',
    );
    const outcomes = Promise.allSettled(start());
    let waiting = 0;
    try {
      for (let i = 0; i < 100 && waiting < 2; i++) {
        const { rows } = await pools[0].query<{ count: string }>(
          "SELECT count(*) FROM pg_locks WHERE relation=$1::regclass AND mode='RowExclusiveLock' AND NOT granted",
          [table],
        );
        waiting = Number(rows[0].count);
        if (waiting < 2) await new Promise((resolve) => setTimeout(resolve, 5));
      }
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    const results = await outcomes;
    expect(waiting).toBe(2); // Both INSERTs have started, not merely two sequential calls.
    expect(results.map((result) => result.status)).toEqual([
      'fulfilled',
      'fulfilled',
    ]);
  }

  beforeAll(async () => {
    pools = [
      new Pool({ connectionString: url }),
      new Pool({ connectionString: url }),
    ];
    db = new PrismaClient({ adapter: new PrismaPg(pools[0]) });
    other = new PrismaClient({ adapter: new PrismaPg(pools[1]) });
    for (const [index, client] of [db, other].entries()) {
      await assertTestDatabase(pools[index]);
      Object.assign(client, { postgresqlPool: pools[index] });
    }
    isolated = true;
    await db.challenge.deleteMany({
      where: { id: { startsWith: 'p6-test-' } },
    });
    await db.achievement.deleteMany({
      where: { id: { startsWith: 'p6-test-' } },
    });
    await db.user.create({
      data: {
        id: owner,
        firebase_uid: owner,
        email: `${owner}@example.test`,
        role: 'SUPER_ADMIN',
        fcm_token: 'good',
      },
    });
  });

  beforeEach(async () => {
    await db.notification.deleteMany({ where: { sender_id: owner } });
    await db.durableWork.deleteMany({
      where: { OR: [{ key: { startsWith: prefix } }, { owner_id: owner }] },
    });
    one = new JobsService(asService(db));
    two = new JobsService(asService(other));
    notifications = new NotificationsService(asService(db), one);
    notifications.onModuleInit();
    new NotificationsService(asService(other), two).onModuleInit();
    sendMock.mockReset().mockResolvedValue('provider-accepted');
  });

  afterAll(async () => {
    if (!isolated) {
      await Promise.all([db?.$disconnect(), other?.$disconnect()]);
      await Promise.all((pools ?? []).map((pool) => pool.end()));
      return;
    }
    await db.challenge.deleteMany({ where: { id: { startsWith: prefix } } });
    await db.achievement.deleteMany({ where: { id: { startsWith: prefix } } });
    await db.durableWork.deleteMany({ where: { key: { startsWith: prefix } } });
    await db.user.delete({ where: { id: owner } });
    await Promise.all([db.$disconnect(), other.$disconnect()]);
    await Promise.all(pools.map((pool) => pool.end()));
  });

  it('P6-01: two schedulers persist one occurrence across restart', async () => {
    const template = 'training_reminder_daily';
    const now = new Date();
    const time = now.toISOString().slice(11, 16);
    await db.notificationTemplateSchedule.upsert({
      where: { template_key: template },
      create: { template_key: template, times: [time], timezone: 'UTC' },
      update: { times: [time], timezone: 'UTC', enabled: true },
    });
    const materializer = {
      reconcile: jest.fn(),
    } as unknown as AutoAssignmentMaterializerService;
    const first = new NotificationsSchedulerService(
      asService(db),
      notifications,
      materializer,
      one,
    );
    const second = new NotificationsSchedulerService(
      asService(other),
      notifications,
      materializer,
      two,
    );
    await Promise.all([
      first.runScheduledNotifications(),
      second.runScheduledNotifications(),
    ]);
    await new NotificationsSchedulerService(
      asService(db),
      notifications,
      materializer,
      one,
    ).runScheduledNotifications();
    const occurrence = `schedule:${template}:${now.toISOString().slice(0, 10)}:${time}`;
    expect(await db.durableWork.count({ where: { key: occurrence } })).toBe(1);
    first.onModuleInit();
    second.onModuleInit();
    await Promise.all([one.runKey(occurrence), two.runKey(occurrence)]);
    expect(
      await db.durableWork.findUniqueOrThrow({ where: { key: occurrence } }),
    ).toMatchObject({ status: 'DONE', attempts: 1 });
    await db.durableWork.deleteMany({ where: { key: occurrence } });
    await db.notificationTemplateSchedule.delete({
      where: { template_key: template },
    });
  });

  it('P6-01: live lease expiry cannot overlap a second instance', async () => {
    const entered = gate(),
      release = gate();
    let count = 0;
    const handler = async () => {
      count++;
      entered.release();
      await release.promise;
    };
    one.register('TEST', handler);
    two.register('TEST', handler);
    await enqueueWork(db, key('exclusive'), 'TEST', {});
    const first = one.runKey(key('exclusive'));
    await entered.promise;
    expect((await work('exclusive')).status).toBe('RUNNING');
    await db.durableWork.update({
      where: { key: key('exclusive') },
      data: { lease_until: new Date(0) },
    });
    await two.runKey(key('exclusive'));
    expect(count).toBe(1);
    release.release();
    await first;
    await two.runKey(key('exclusive'));
    expect(count).toBe(1);
    expect((await work('exclusive')).status).toBe('DONE');
  });

  it('P6-01/ISSUE-060: concurrent schedule inserts resolve their unique conflict in PostgreSQL', async () => {
    await concurrentInserts('durable_work', () => [
      enqueueWork(db, key('insert-race'), 'TEST', { original: true }),
      enqueueWork(other, key('insert-race'), 'TEST', { original: false }),
    ]);
    expect(
      await db.durableWork.count({ where: { key: key('insert-race') } }),
    ).toBe(1);
  });

  it('P6-02/04 ISSUE-060: duplicate consumers atomically create one notification child', async () => {
    await enqueueWork(db, key('child-race'), 'TEST', {}, owner);
    const event = await work('child-race');
    const second = new NotificationsService(asService(other), two);
    await concurrentInserts('notifications', () => [
      workContext.run(event, () =>
        notifications.sendInternalNotifications(
          owner,
          [owner],
          'child',
          'test',
          { type: 'child-race' },
        ),
      ),
      workContext.run(event, () =>
        second.sendInternalNotifications(owner, [owner], 'child', 'test', {
          type: 'child-race',
        }),
      ),
    ]);
    expect(
      await db.notification.count({ where: { recipient_id: owner } }),
    ).toBe(1);
    expect(
      await db.durableWork.count({ where: { owner_id: owner, kind: 'FCM' } }),
    ).toBe(1);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('P6-01: abandoned claim is recovered with a new token', async () => {
    await enqueueWork(db, key('abandoned'), 'TEST', {});
    await db.durableWork.update({
      where: { key: key('abandoned') },
      data: {
        status: 'RUNNING',
        claim_token: 'dead-process',
        lease_until: new Date(0),
        attempts: 1,
      },
    });
    const handler = jest.fn().mockResolvedValue(undefined);
    two.register('TEST', handler);
    await two.runKey(key('abandoned'));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(await work('abandoned')).toMatchObject({
      status: 'DONE',
      attempts: 2,
      claim_token: null,
    });
  });

  it('P6-01: a crashed worker releases its real guard and another instance recovers the claim', async () => {
    await enqueueWork(db, key('worker-crash'), 'CRASH_RECOVERY', {});
    const child = spawn(
      process.execPath,
      [resolve(__dirname, 'worker-crash.fixture.cjs'), key('worker-crash')],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once('exit', resolve);
      child.once('error', reject);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout.on('data', (data: Buffer) => {
          if (data.toString().includes('CLAIMED')) resolve();
        });
        child.once('exit', () =>
          reject(new Error('Worker exited before claiming')),
        );
        child.once('error', reject);
      });
      expect(await work('worker-crash')).toMatchObject({
        status: 'RUNNING',
        attempts: 1,
      });
      child.stdin.end('crash');
      expect(await exited).toBe(23);
      const handler = jest.fn().mockResolvedValue(undefined);
      two.register('CRASH_RECOVERY', handler);
      await two.runKey(key('worker-crash'));
      expect(handler).not.toHaveBeenCalled(); // lease still protects the abandoned claim
      await due('worker-crash');
      await two.runKey(key('worker-crash'));
      expect(handler).toHaveBeenCalledTimes(1);
      expect(await work('worker-crash')).toMatchObject({
        status: 'DONE',
        attempts: 2,
        claim_token: null,
      });
    } finally {
      if (child.exitCode === null) child.kill();
      await exited;
    }
  }, 20000);

  it('P6-01/ISSUE-058: a live handler outlasts the former Prisma guard deadline', async () => {
    const entered = gate(),
      release = gate();
    let calls = 0;
    const handler = async () => {
      calls++;
      entered.release();
      await release.promise;
    };
    one.register('TEST', handler);
    two.register('TEST', handler);
    await enqueueWork(db, key('guard-deadline'), 'TEST', {});
    // Accelerate only the former five-minute guard timer, preserving real PG
    // interleavings. A callback can keep running after Prisma expires its TX.
    const realTimeout = global.setTimeout;
    const timer = jest
      .spyOn(global, 'setTimeout')
      .mockImplementation((callback, ms, ...args) =>
        realTimeout(callback, ms === 300_000 ? 500 : ms, ...args),
      );
    const first = one.runKey(key('guard-deadline')).catch(() => undefined);
    try {
      await entered.promise;
      timer.mockRestore();
      await db.durableWork.update({
        where: { key: key('guard-deadline') },
        data: { lease_until: new Date(0) },
      });
      await new Promise((resolve) => realTimeout(resolve, 750));
      // Do not await the second handler: the defective implementation would
      // enter and wait at the same gate, hiding the overlap behind a timeout.
      let secondFinished = false;
      const second = two.runKey(key('guard-deadline')).finally(() => {
        secondFinished = true;
      });
      await new Promise((resolve) => realTimeout(resolve, 100));
      const observedCalls = calls;
      const observedFinished = secondFinished;
      release.release();
      await Promise.all([first, second]);
      expect(observedCalls).toBe(1);
      expect(observedFinished).toBe(true);
      expect(await work('guard-deadline')).toMatchObject({
        status: 'DONE',
        attempts: 1,
      });
    } finally {
      release.release();
      await first;
      timer.mockRestore();
    }
  });

  it('P6-01: global concurrency is four across two instances', async () => {
    const entered = gate(),
      release = gate();
    let active = 0,
      maximum = 0;
    const handler = async () => {
      active++;
      maximum = Math.max(maximum, active);
      if (active === 4) entered.release();
      await release.promise;
      active--;
    };
    one.register('TEST', handler);
    two.register('TEST', handler);
    for (let i = 0; i < 8; i++)
      await enqueueWork(db, key(`limit-${i}`), 'TEST', {});
    const runs = Promise.all([one.drain(), two.drain()]);
    await entered.promise;
    expect(active).toBe(4);
    release.release();
    await runs;
    expect(maximum).toBe(4);
  });

  it('P6-02: rollback removes business, milestone and reconcile work', async () => {
    await expect(
      db.$transaction(async (tx) => {
        await tx.streak.create({
          data: {
            client_id: owner,
            current_days: 7,
            longest_days: 7,
            last_active_date: new Date('2026-09-11'),
          },
        });
        expect(await tx.durableWork.count({ where: { owner_id: owner } })).toBe(
          2,
        );
        throw Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await db.streak.count({ where: { client_id: owner } })).toBe(0);
    expect(await db.durableWork.count({ where: { owner_id: owner } })).toBe(0);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('P6-02/04: committed progress survives producer crash; unchanged replay is coalesced', async () => {
    await db.$transaction(async (tx) => {
      await tx.dayProgress.create({
        data: {
          client_id: owner,
          date: new Date('2099-01-01'),
          training_completed: true,
        },
      });
      await tx.dayProgress.update({
        where: {
          client_id_date: { client_id: owner, date: new Date('2099-01-01') },
        },
        data: { notes: 'same transaction' },
      });
    });
    expect(
      await db.durableWork.count({
        where: { owner_id: owner, kind: 'RECONCILE' },
      }),
    ).toBe(1);
    await db.dayProgress.update({
      where: {
        client_id_date: { client_id: owner, date: new Date('2099-01-01') },
      },
      data: { notes: 'same transaction' },
    });
    expect(
      await db.durableWork.count({
        where: { owner_id: owner, kind: 'RECONCILE' },
      }),
    ).toBe(1);
    await db.dayProgress.deleteMany({ where: { client_id: owner } });
  });

  async function pending(name: string) {
    return db.notification.create({
      data: {
        id: key(name),
        sender_id: owner,
        recipient_id: owner,
        title: 'test',
        body: 'test',
      },
    });
  }

  it('P6-03: no SENT before provider acceptance, then receipt and SENT', async () => {
    const entered = gate(),
      release = gate();
    sendMock.mockImplementation(async () => {
      entered.release();
      await release.promise;
      return 'accepted-id';
    });
    await pending('send');
    const dispatch = one.runKey(key('send'));
    await entered.promise;
    expect(
      (await db.notification.findUniqueOrThrow({ where: { id: key('send') } }))
        .status,
    ).toBe('PENDING');
    release.release();
    await dispatch;
    expect(
      await db.notification.findUniqueOrThrow({ where: { id: key('send') } }),
    ).toMatchObject({
      status: 'SENT',
      provider_message_id: 'accepted-id',
      read_at: null,
    });
  });

  it('P6-03: failure/response loss stays pending and backs off; retry succeeds', async () => {
    await pending('lost');
    sendMock.mockRejectedValueOnce(Error('secret-provider-response'));
    await one.runKey(key('lost'));
    expect(await work('lost')).toMatchObject({
      status: 'PENDING',
      attempts: 1,
      last_error: 'ATTEMPT_FAILED_OR_AMBIGUOUS',
    });
    expect((await work('lost')).next_attempt_at.getTime()).toBeGreaterThan(
      Date.now(),
    );
    await two.runKey(key('lost'));
    expect(sendMock).toHaveBeenCalledTimes(1);
    await due('lost');
    await two.runKey(key('lost'));
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect((await work('lost')).status).toBe('DONE');
  });

  it('P6-03: acceptance followed by crash before SENT allows residual duplicate', async () => {
    await pending('crash');
    const update = jest
      .spyOn(db.notification, 'update')
      .mockRejectedValueOnce(Error('crash-before-receipt'));
    await one.runKey(key('crash'));
    update.mockRestore();
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(
      (await db.notification.findUniqueOrThrow({ where: { id: key('crash') } }))
        .status,
    ).toBe('PENDING');
    await due('crash');
    await two.runKey(key('crash'));
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect((await work('crash')).status).toBe('DONE');
    expect(sendMock.mock.calls[0][0].data.notification_id).toBe(
      sendMock.mock.calls[1][0].data.notification_id,
    );
  });

  it('P6-03: crash after SENT before work DONE never resends', async () => {
    await pending('recorded');
    await notifications.dispatchNotification(key('recorded'));
    await two.runKey(key('recorded'));
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect((await work('recorded')).status).toBe('DONE');
  });

  it('P6-03: attempts are bounded and terminal failure remains visible', async () => {
    await pending('poison');
    sendMock.mockRejectedValue(Error('timeout'));
    for (let i = 0; i < WORK_MAX_ATTEMPTS; i++) {
      await due('poison');
      await one.runKey(key('poison'));
    }
    await two.runKey(key('poison'));
    expect(sendMock).toHaveBeenCalledTimes(WORK_MAX_ATTEMPTS);
    expect((await work('poison')).status).toBe('FAILED');
    expect(
      (
        await db.notification.findUniqueOrThrow({
          where: { id: key('poison') },
        })
      ).status,
    ).toBe('FAILED');
  });

  it('P6-03: one failed recipient does not roll back accepted recipients', async () => {
    await pending('partial-a');
    await pending('partial-b');
    sendMock.mockImplementation((message) =>
      message.data.notification_id === key('partial-b')
        ? Promise.reject(Error('offline'))
        : Promise.resolve('accepted'),
    );
    await Promise.all([
      one.runKey(key('partial-a')),
      two.runKey(key('partial-b')),
    ]);
    expect((await work('partial-a')).status).toBe('DONE');
    expect((await work('partial-b')).status).toBe('PENDING');
  });

  it('P6-04: repeated milestone recomputation retains one durable event', async () => {
    const data = {
      current_days: 7,
      longest_days: 7,
      last_active_date: new Date('2026-09-11'),
    };
    await db.streak.upsert({
      where: { client_id: owner },
      create: { client_id: owner, ...data },
      update: data,
    });
    await db.streak.update({
      where: { client_id: owner },
      data: { current_days: 6 },
    });
    await db.streak.update({ where: { client_id: owner }, data });
    expect(
      await db.durableWork.count({
        where: { owner_id: owner, kind: 'STREAK_MILESTONE' },
      }),
    ).toBe(1);
    const achievements = new AchievementsService(asService(db), notifications);
    const challenges = new ChallengesService(
      asService(db),
      achievements,
      notifications,
    );
    new DomainWorkService(
      asService(db),
      one,
      challenges,
      achievements,
      notifications,
    ).onModuleInit();
    const milestone = await db.durableWork.findFirstOrThrow({
      where: { owner_id: owner, kind: 'STREAK_MILESTONE' },
    });
    await one.runKey(milestone.key);
    expect(
      await db.notification.findFirstOrThrow({
        where: { recipient_id: owner },
      }),
    ).toMatchObject({
      title: '7 días de racha!',
      body: 'Sigue así. Tu constancia está creciendo.',
      status: 'PENDING',
      data: { type: 'streak', route: '/' },
    });
    expect(sendMock).not.toHaveBeenCalled();
    await db.streak.delete({ where: { client_id: owner } });
  });

  it('P6-01: recipient mapper bounds hundreds of operations', async () => {
    let active = 0,
      maximum = 0;
    const values = await boundedMap(
      Array.from({ length: 500 }, (_, i) => i),
      async (i) => {
        active++;
        maximum = Math.max(maximum, active);
        await Promise.resolve();
        active--;
        return i;
      },
    );
    expect(values).toHaveLength(500);
    expect(maximum).toBe(4);
  });

  it('P6-02/03: approval rollback has no event and unconfirmed execution never announces success', async () => {
    const achievements = new AchievementsService(asService(db), notifications);
    const challenges = new ChallengesService(
      asService(db),
      achievements,
      notifications,
    );
    new DomainWorkService(
      asService(db),
      one,
      challenges,
      achievements,
      notifications,
    ).onModuleInit();
    const data = {
      requester_id: owner,
      action_type: 'training.delete',
      resource_type: 'training',
      payload: {},
    };
    await expect(
      db.$transaction(async (tx) => {
        await tx.approvalRequest.create({ data });
        throw Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(
      await db.durableWork.count({
        where: { owner_id: owner, kind: 'APPROVAL_PENDING' },
      }),
    ).toBe(0);
    const approval = await db.approvalRequest.create({ data });
    await db.approvalRequest.update({
      where: { id: approval.id },
      data: { status: 'APPROVED', reviewer_id: owner },
    });
    const event = `APPROVAL_RESOLUTION:${approval.id}`;
    await one.runKey(event);
    expect(
      await db.durableWork.findUniqueOrThrow({ where: { key: event } }),
    ).toMatchObject({
      status: 'PENDING',
      last_error: 'APPROVAL_EXECUTION_UNCONFIRMED',
    });
    expect(
      await db.notification.count({ where: { recipient_id: owner } }),
    ).toBe(0);
    await db.durableWork.update({
      where: { key: event },
      data: { status: 'FAILED', attempts: 8 },
    });
    await db.approvalRequest.update({
      where: { id: approval.id },
      data: { execution_completed_at: new Date() },
    });
    await one.runKey(event);
    expect(
      await db.durableWork.findUniqueOrThrow({ where: { key: event } }),
    ).toMatchObject({ status: 'DONE', attempts: 1 });
    expect(
      await db.notification.count({
        where: { recipient_id: owner, status: 'PENDING' },
      }),
    ).toBe(1);
    expect(sendMock).not.toHaveBeenCalled();
    await one.runKey(event);
    expect(
      await db.notification.count({ where: { recipient_id: owner } }),
    ).toBe(1);
    await db.approvalRequest.delete({ where: { id: approval.id } });
  });

  it('P6-03/ISSUE-061: a confirmation racing the last failed attempt remains recoverable', async () => {
    const achievements = new AchievementsService(asService(db), notifications);
    const challenges = new ChallengesService(
      asService(db),
      achievements,
      notifications,
    );
    const domain = new DomainWorkService(
      asService(db),
      one,
      challenges,
      achievements,
      notifications,
    );
    domain.onModuleInit();
    const approval = await db.approvalRequest.create({
      data: {
        requester_id: owner,
        action_type: 'training.delete',
        resource_type: 'training',
        payload: {},
      },
    });
    await db.approvalRequest.update({
      where: { id: approval.id },
      data: { status: 'APPROVED', reviewer_id: owner },
    });
    const event = `APPROVAL_RESOLUTION:${approval.id}`;
    await db.durableWork.update({
      where: { key: event },
      data: { attempts: 7 },
    });
    const entered = gate(),
      release = gate();
    const original = new DomainWorkService(
      asService(db),
      one,
      challenges,
      achievements,
      notifications,
    );
    const pause = jest
      .spyOn(domain, 'approval')
      .mockImplementation(async (work) => {
        try {
          await original.approval(work);
        } catch (error) {
          entered.release();
          await release.promise;
          throw error;
        }
      });
    const running = one.runKey(event);
    try {
      await entered.promise; // the consumer observed APPROVED without execution evidence
      await db.approvalRequest.update({
        where: { id: approval.id },
        data: { execution_completed_at: new Date() },
      });
      release.release();
      await running;
      expect(
        await db.durableWork.findUniqueOrThrow({ where: { key: event } }),
      ).toMatchObject({ status: 'PENDING', attempts: 0, claim_token: null });
      pause.mockRestore();
      await one.runKey(event);
      expect(
        await db.durableWork.findUniqueOrThrow({ where: { key: event } }),
      ).toMatchObject({ status: 'DONE', attempts: 1 });
      expect(
        await db.notification.findFirstOrThrow({
          where: { recipient_id: owner },
        }),
      ).toMatchObject({
        title: 'Solicitud aprobada',
        status: 'PENDING',
        data: { type: 'approval_approved', route: '/approval-requests' },
      });
      expect(sendMock).not.toHaveBeenCalled();
    } finally {
      release.release();
      await running;
      pause.mockRestore();
      await db.approvalRequest.delete({ where: { id: approval.id } });
    }
  });

  it('P6-02: the complete audience is committed before the first provider call', async () => {
    const recipients = [key('audience-a'), key('audience-b')];
    await db.user.createMany({
      data: recipients.map((id) => ({
        id,
        firebase_uid: id,
        email: `${id}@example.test`,
        fcm_token: 'good',
      })),
    });
    try {
      sendMock.mockImplementation(async () => {
        expect(
          await other.notification.count({
            where: { recipient_id: { in: recipients } },
          }),
        ).toBe(2);
        expect(
          await other.durableWork.count({
            where: { owner_id: { in: recipients }, kind: 'FCM' },
          }),
        ).toBe(2);
        return 'accepted';
      });
      await notifications.sendToMultiple(
        owner,
        recipients,
        'atomic audience',
        'test',
      );
      expect(sendMock).toHaveBeenCalledTimes(2);
    } finally {
      await db.user.deleteMany({ where: { id: { in: recipients } } });
    }
  });

  it('P6-03: queued manual delivery checks revoked sender authority again', async () => {
    const recipient = key('revoked-recipient');
    await db.user.create({
      data: {
        id: recipient,
        firebase_uid: recipient,
        email: `${recipient}@example.test`,
        fcm_token: 'good',
      },
    });
    try {
      await notifications.queueAuthorizedNotifications(
        owner,
        [recipient],
        'queued',
        'test',
      );
      const event = await db.durableWork.findFirstOrThrow({
        where: { owner_id: recipient, kind: 'FCM' },
      });
      await db.user.update({ where: { id: owner }, data: { role: 'CLIENT' } });
      await one.runKey(event.key);
      expect(
        await db.durableWork.findUniqueOrThrow({ where: { key: event.key } }),
      ).toMatchObject({
        status: 'FAILED',
        last_error: 'AUTHORIZATION_REVOKED',
      });
      expect(sendMock).not.toHaveBeenCalled();
    } finally {
      await db.user.update({
        where: { id: owner },
        data: { role: 'SUPER_ADMIN' },
      });
      await db.user.delete({ where: { id: recipient } });
    }
  });

  it.each(['feedback_submitted', 'weekly_summary', 'client_assigned'])(
    'P6-03/ISSUE-059: queued %s respects revoked recipient assignments',
    async (type) => {
      const client = key('private-client'),
        trainer = key('former-trainer');
      await db.user.createMany({
        data: [
          {
            id: client,
            firebase_uid: client,
            email: `${client}@example.test`,
            role: 'CLIENT',
          },
          {
            id: trainer,
            firebase_uid: trainer,
            email: `${trainer}@example.test`,
            role: 'ADMIN',
            fcm_token: 'good',
          },
        ],
      });
      try {
        const assignment = await db.adminClientAssignment.create({
          data: { admin_id: trainer, client_id: client },
        });
        await notifications.sendInternalNotifications(
          owner,
          [trainer],
          'private client event',
          'test',
          { type, client_id: client },
        );
        const event = await db.durableWork.findFirstOrThrow({
          where: { owner_id: trainer, kind: 'FCM' },
        });
        await db.adminClientAssignment.update({
          where: { id: assignment.id },
          data: { is_active: false },
        });
        await two.runKey(event.key);
        expect(
          await db.durableWork.findUniqueOrThrow({ where: { key: event.key } }),
        ).toMatchObject({
          status: 'FAILED',
          last_error: 'RECIPIENT_AUTHORIZATION_REVOKED',
        });
        expect(sendMock).not.toHaveBeenCalled();
        await db.adminClientAssignment.update({
          where: { id: assignment.id },
          data: { is_active: true },
        });
        await notifications.sendInternalNotifications(
          owner,
          [trainer],
          'authorized new event',
          'test',
          { type, client_id: client },
        );
        const authorized = await db.durableWork.findFirstOrThrow({
          where: { owner_id: trainer, kind: 'FCM', status: 'PENDING' },
        });
        await two.runKey(authorized.key);
        expect(sendMock).toHaveBeenCalledTimes(1);
        expect(
          await db.notification.findUniqueOrThrow({
            where: { id: authorized.key },
          }),
        ).toMatchObject({ status: 'SENT' });
      } finally {
        await db.user.deleteMany({ where: { id: { in: [trainer, client] } } });
      }
    },
  );

  it('P6-03/ISSUE-059: queued approval notice rejects a demoted reviewer', async () => {
    await notifications.sendInternalNotifications(
      owner,
      [owner],
      'approval',
      'test',
      { type: 'approval_pending' },
    );
    const event = await db.durableWork.findFirstOrThrow({
      where: { owner_id: owner, kind: 'FCM' },
    });
    try {
      await db.user.update({ where: { id: owner }, data: { role: 'CLIENT' } });
      await two.runKey(event.key);
      expect(
        await db.durableWork.findUniqueOrThrow({ where: { key: event.key } }),
      ).toMatchObject({
        status: 'FAILED',
        last_error: 'RECIPIENT_AUTHORIZATION_REVOKED',
      });
      expect(sendMock).not.toHaveBeenCalled();
    } finally {
      await db.user.update({
        where: { id: owner },
        data: { role: 'SUPER_ADMIN' },
      });
    }
  });

  it('P6-03: operations HTTP endpoint restricts roles and hides private payloads', async () => {
    await enqueueWork(
      db,
      key('private'),
      'EMAIL',
      { private: 'private-test-value' },
      owner,
    );
    await db.durableWork.update({
      where: { key: key('private') },
      data: { status: 'FAILED' },
    });
    const module = await Test.createTestingModule({
      controllers: [NotificationsController],
      providers: [
        {
          provide: NotificationsService,
          useValue: new NotificationsService(
            asService(db),
            new JobsService(asService(db)),
          ),
        },
        {
          provide: APP_GUARD,
          useValue: {
            canActivate(context: ExecutionContext) {
              const req = context.switchToHttp().getRequest<{
                headers: Record<string, string>;
                user: { role: Role };
              }>();
              req.user = { role: req.headers['x-test-role'] as Role };
              return true;
            },
          },
        },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    }).compile();
    const app: INestApplication<Server> = module.createNestApplication();
    await app.init();
    try {
      await request(app.getHttpServer())
        .get('/notifications/delivery-work')
        .set('x-test-role', 'ADMIN')
        .expect(403);
      const response = await request(app.getHttpServer())
        .get('/notifications/delivery-work')
        .set('x-test-role', 'SUPER_ADMIN')
        .expect(200);
      expect(response.text).toContain('FAILED');
      expect(response.text).not.toContain('private-test-value');
      expect(response.text).not.toContain('"payload"');
    } finally {
      await app.close();
    }
  });

  it('P6-04: catalog commit retains recalculation and CUSTOM conversion preserves manual grants', async () => {
    const id = key('catalog');
    await db.user.update({ where: { id: owner }, data: { role: 'CLIENT' } });
    try {
      await db.achievement.create({
        data: {
          id,
          name: 'catalog',
          description: 'test',
          criteria_type: 'TRAINING_DAYS',
          criteria_value: 1,
        },
      });
      expect(
        await db.durableWork.count({
          where: { owner_id: owner, kind: 'RECONCILE' },
        }),
      ).toBeGreaterThan(0);
      await db.userAchievement.create({
        data: { user_id: owner, achievement_id: id, unlock_source: 'MANUAL' },
      });
      await db.achievement.update({
        where: { id },
        data: { criteria_type: 'CUSTOM' },
      });
      expect(
        await db.userAchievement.count({
          where: {
            user_id: owner,
            achievement_id: id,
            unlock_source: 'MANUAL',
          },
        }),
      ).toBe(1);
    } finally {
      await db.achievement.delete({ where: { id } });
      await db.user.update({
        where: { id: owner },
        data: { role: 'SUPER_ADMIN' },
      });
    }
  });

  it('P6-04: a fresh consumer recovers aggregates after producer crash, with idempotent effects', async () => {
    const achievements = new AchievementsService(asService(db), notifications);
    const challenges = new ChallengesService(
      asService(db),
      achievements,
      notifications,
    );
    new DomainWorkService(
      asService(db),
      one,
      challenges,
      achievements,
      notifications,
    ).onModuleInit();
    const challengeId = key('challenge'),
      achievementId = key('achievement');
    await db.achievement.create({
      data: {
        id: achievementId,
        name: 'One training',
        description: 'test',
        criteria_type: 'TRAINING_DAYS',
        criteria_value: 1,
      },
    });
    await db.challenge.create({
      data: {
        id: challengeId,
        title: 'One training',
        description: 'test',
        type: 'WEEKLY',
        target_value: 1,
        unit: 'days',
        rule_key: 'TRAINING_DAYS',
        is_manual: false,
        created_by: owner,
      },
    });
    await db.challengeClient.create({
      data: {
        challenge_id: challengeId,
        client_id: owner,
        assigned_at: new Date('2026-01-01'),
      },
    });
    const date = new Date(new Date().toISOString().slice(0, 10));
    // A separate producer exits without closing its connection or executing
    // post-commit hooks. Recovery must come from PostgreSQL, not its memory.
    const producer = spawnSync(
      process.execPath,
      [
        '-e',
        `
      const {Client}=require(process.argv[1]);
      (async()=>{
        const db=new Client({connectionString:process.env.P6_TEST_DATABASE_URL});
        await db.connect();await db.query('BEGIN');
        await db.query('INSERT INTO day_progress(id,client_id,date,training_completed,updated_at) VALUES($1,$2,$3,true,now())',
          [process.env.P6_PROGRESS_ID,process.env.P6_OWNER,process.env.P6_DATE]);
        await db.query('COMMIT');process.exit(23);
      })().catch(()=>process.exit(24));
    `,
        require.resolve('pg'),
      ],
      {
        env: {
          ...process.env,
          P6_TEST_DATABASE_URL: url,
          P6_PROGRESS_ID: key('crashed-producer'),
          P6_OWNER: owner,
          P6_DATE: date.toISOString(),
        },
        timeout: 10000,
        windowsHide: true,
      },
    );
    expect(producer.status).toBe(23);
    const event = await db.durableWork.findFirstOrThrow({
      where: { owner_id: owner, kind: 'RECONCILE' },
      orderBy: { created_at: 'desc' },
    });
    const fail = jest
      .spyOn(achievements, 'evaluateAutomaticAchievementsForUser')
      .mockRejectedValueOnce(Error('consumer crash'));
    await one.runKey(event.key);
    expect(
      (
        await db.challengeClient.findUniqueOrThrow({
          where: {
            challenge_id_client_id: {
              challenge_id: challengeId,
              client_id: owner,
            },
          },
        })
      ).is_completed,
    ).toBe(false);
    expect(
      (await db.durableWork.findUniqueOrThrow({ where: { key: event.key } }))
        .status,
    ).toBe('PENDING');
    fail.mockRestore();
    await db.durableWork.update({
      where: { key: event.key },
      data: { next_attempt_at: new Date(0) },
    });
    await one.runKey(event.key);
    expect(
      (
        await db.challengeClient.findUniqueOrThrow({
          where: {
            challenge_id_client_id: {
              challenge_id: challengeId,
              client_id: owner,
            },
          },
        })
      ).is_completed,
    ).toBe(true);
    expect(
      await db.userAchievement.count({
        where: { user_id: owner, achievement_id: achievementId },
      }),
    ).toBe(1);
    const events = await db.durableWork.findMany({
      where: {
        owner_id: owner,
        kind: { in: ['ACHIEVEMENT', 'CHALLENGE_COMPLETED'] },
      },
    });
    expect(events).toHaveLength(2);
    for (const row of events) {
      await one.runKey(row.key);
      await db.durableWork.update({
        where: { key: row.key },
        data: { status: 'PENDING', next_attempt_at: new Date(0) },
      });
      await one.runKey(row.key);
    }
    expect(
      await db.notification.count({ where: { recipient_id: owner } }),
    ).toBe(2);
    expect(
      await db.notification.findMany({
        where: { recipient_id: owner },
        orderBy: { title: 'asc' },
      }),
    ).toMatchObject([
      {
        title: 'Logro desbloqueado',
        body: 'One training',
        status: 'PENDING',
        data: {
          type: 'achievement',
          achievement_id: achievementId,
          route: '/achievements',
        },
      },
      {
        title: 'Reto completado: One training',
        status: 'PENDING',
        data: {
          type: 'challenge',
          challenge_id: challengeId,
          route: '/challenges',
        },
      },
    ]);
    await db.dayProgress.update({
      where: { client_id_date: { client_id: owner, date } },
      data: { training_completed: false },
    });
    // Even an old event reads current business state; it cannot replay stale aggregates.
    await db.durableWork.update({
      where: { key: event.key },
      data: { status: 'PENDING', next_attempt_at: new Date(0) },
    });
    await one.runKey(event.key);
    expect(
      await db.userAchievement.count({
        where: { user_id: owner, achievement_id: achievementId },
      }),
    ).toBe(0);
    expect(
      (
        await db.challengeClient.findUniqueOrThrow({
          where: {
            challenge_id_client_id: {
              challenge_id: challengeId,
              client_id: owner,
            },
          },
        })
      ).is_completed,
    ).toBe(false);
    await db.dayProgress.deleteMany({ where: { client_id: owner } });
    await db.challenge.delete({ where: { id: challengeId } });
    await db.achievement.delete({ where: { id: achievementId } });
  });
});
