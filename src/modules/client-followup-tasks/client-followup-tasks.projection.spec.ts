import { randomUUID } from 'node:crypto';
import { ForbiddenException } from '@nestjs/common';
import {
  ClientFollowUpTaskPriority as Priority,
  ClientFollowUpTaskStatus as Status,
  ClientFollowUpTaskType as TaskType,
  Prisma,
  Role,
} from '@prisma/client';
import { Pool } from 'pg';
import { assertTestDatabase } from '../../../scripts/test-database.cjs';
import { PrismaService } from '../../prisma/prisma.service';
import { ClientFollowUpTasksService } from './client-followup-tasks.service';
import { nextTasksQuery } from './client-followup-tasks.queries';

it('binds owner twice and bounds each independent selector in one read statement', () => {
  const query = nextTasksQuery("owner' OR TRUE --");
  expect(query.values).toEqual(["owner' OR TRUE --", "owner' OR TRUE --"]);
  expect(query.sql.match(/LIMIT 1/g)).toHaveLength(2);
  expect(query.sql).toContain('UNION ALL');
  expect(query.sql).toContain("AND type = 'REVIEW'");
  expect(
    query.sql.match(/status IN \('PENDING', 'IN_PROGRESS'\)/g),
  ).toHaveLength(2);
  expect(
    query.sql.match(
      /WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 WHEN 'LOW' THEN 2/g,
    ),
  ).toHaveLength(2);
  expect(query.sql.match(/created_at ASC, id ASC/g)).toHaveLength(2);
  expect(query.sql).not.toMatch(/INSERT|UPDATE|DELETE|SELECT \*/);
});

// Real-PG tests are deliberately registered only by the owned-cluster runner.
// ALL and PG assert this suite executed; unit mode runs the structural assertion.
if (process.env.FOLLOWUP_SERVICE_PG === '1') {
  describe('REST-T2D canonical read projection on real PostgreSQL', () => {
    const prefix = `t2d-${randomUUID()}`;
    const admin = prefix + '-admin';
    const oldAssignee = prefix + '-old';
    const superId = prefix + '-super';
    const actor = { id: superId, role: Role.SUPER_ADMIN };
    let prisma: PrismaService;
    let service: ClientFollowUpTasksService;
    let pool: Pool;
    beforeAll(async () => {
      pool = new Pool({
        connectionString: process.env.TEST_DATABASE_URL,
        ssl: false,
      });
      await assertTestDatabase(pool);
      prisma = new PrismaService();
      await prisma.$connect();
      service = new ClientFollowUpTasksService(prisma);
      await prisma.user.createMany({
        data: [admin, oldAssignee, superId].map((id) => ({
          id,
          firebase_uid: id,
          email: `${id}@example.test`,
          role: id === superId ? Role.SUPER_ADMIN : Role.ADMIN,
          is_active: id !== oldAssignee,
        })),
      });
    });
    afterAll(async () => {
      jest.useRealTimers();
      await prisma?.$disconnect();
      if (prisma && !prisma.postgresqlPool.ended)
        await prisma.postgresqlPool.end();
      await pool?.end();
    });
    async function owner() {
      const id = prefix + '-' + randomUUID();
      await prisma.user.create({
        data: {
          id,
          firebase_uid: id,
          email: `${id}@example.test`,
          role: Role.CLIENT,
        },
      });
      await prisma.adminClientAssignment.create({
        data: { client_id: id, admin_id: admin },
      });
      return id;
    }
    async function task(
      clientId: string,
      overrides: Partial<Prisma.ClientFollowUpTaskCreateManyInput> = {},
    ) {
      const id = randomUUID();
      await prisma.clientFollowUpTask.createMany({
        data: {
          id,
          client_id: clientId,
          created_by_id: superId,
          assigned_to_id: null,
          title: 'Internal task',
          type: TaskType.CALL,
          priority: Priority.MEDIUM,
          due_date: new Date('2026-10-05'),
          created_at: new Date('2026-10-01'),
          ...overrides,
        },
      });
      return overrides.id ?? id;
    }
    it('returns nulls for empty/closed-only owners and isolates cross-owner data', async () => {
      const client = await owner();
      const other = await owner();
      await task(other, { type: TaskType.REVIEW });
      expect(await service.summary(client, actor)).toMatchObject({
        next_task: null,
        next_review: null,
      });
      await task(client, {
        status: Status.COMPLETED,
        completed_at: new Date(),
        due_date: new Date('2000-01-01'),
      });
      await task(client, {
        status: Status.CANCELLED,
        cancelled_at: new Date(),
        type: TaskType.REVIEW,
      });
      expect(await service.summary(client, actor)).toMatchObject({
        next_task: null,
        next_review: null,
      });
    });
    it('selects independent review, includes in-progress and retains unassigned/old assignee', async () => {
      const client = await owner();
      const call = await task(client, { due_date: new Date('2026-10-04') });
      const review = await task(client, {
        type: TaskType.REVIEW,
        status: Status.IN_PROGRESS,
        assigned_to_id: oldAssignee,
      });
      expect(
        await service.summary(client, { id: admin, role: Role.ADMIN }),
      ).toMatchObject({
        next_task: { id: call, assigned_to_id: null },
        next_review: { id: review, assigned_to_id: oldAssignee },
      });
      const same = await owner();
      const onlyReview = await task(same, { type: TaskType.REVIEW });
      const summary = await service.summary(same, actor);
      expect(summary.next_task?.id).toBe(onlyReview);
      expect(summary.next_review).toEqual(summary.next_task);
    });
    it.each([TaskType.CALL, TaskType.REVIEW])(
      'orders %s by due, explicit priority, oldest creation, then id',
      async (type) => {
        // Pairwise fixtures triangulate each ordering key without mutating reads.
        const cases: Partial<Prisma.ClientFollowUpTaskCreateManyInput>[][] = [
          [
            { due_date: new Date('2026-10-04'), priority: Priority.LOW },
            { due_date: new Date('2026-10-05'), priority: Priority.HIGH },
          ],
          [
            { priority: Priority.HIGH },
            { priority: Priority.MEDIUM },
            { priority: Priority.LOW },
          ],
          [{ priority: Priority.MEDIUM }, { priority: Priority.LOW }],
          [
            { created_at: new Date('2026-09-01') },
            { created_at: new Date('2026-10-01') },
          ],
          [
            { id: '00000000-0000-4000-8000-' + randomUUID().slice(-12) },
            { id: 'ffffffff-ffff-4fff-8fff-' + randomUUID().slice(-12) },
          ],
        ];
        for (const entries of cases) {
          const client = await owner();
          const ids: string[] = [];
          for (const entry of entries)
            ids.push(await task(client, { type, ...entry }));
          const result = await service.summary(client, actor);
          expect(result.next_task?.id).toBe(ids[0]);
          expect(result.next_review?.id ?? null).toBe(
            type === TaskType.REVIEW ? ids[0] : null,
          );
          const rows = await prisma.$queryRaw(nextTasksQuery(client));
          expect(rows).toHaveLength(type === TaskType.REVIEW ? 2 : 1);
        }
      },
    );
    it.each([
      ['2026-10-04T19:59:59-04:00', '2026-10-04', false],
      ['2026-10-04T20:00:00-04:00', '2026-10-05', false],
      ['2026-10-06T02:00:00+02:00', '2026-10-06', true],
    ])(
      'uses UTC civil clock at %s, no server-local timezone',
      async (instant, date, overdue) => {
        const client = await owner();
        const id = await task(client);
        jest.useFakeTimers({
          now: new Date(instant),
          doNotFake: [
            'nextTick',
            'setImmediate',
            'clearImmediate',
            'setTimeout',
            'clearTimeout',
            'setInterval',
            'clearInterval',
            'performance',
            'hrtime',
            'queueMicrotask',
          ],
        });
        try {
          expect(await service.summary(client, actor)).toEqual({
            as_of_date: date,
            next_review: null,
            next_task: {
              id,
              type: TaskType.CALL,
              title: 'Internal task',
              due_date: '2026-10-05',
              priority: Priority.MEDIUM,
              assigned_to_id: null,
              version: 1,
              overdue,
            },
          });
        } finally {
          jest.useRealTimers();
        }
      },
    );
    it('inherits eligibility, persisted role and assignment scope without filtering by assignee', async () => {
      const client = await owner();
      await task(client);
      await expect(
        service.summary(client, { id: client, role: Role.CLIENT }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        service.summary(client, { id: oldAssignee, role: Role.ADMIN }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        service.summary(client, { id: admin, role: Role.SUPER_ADMIN }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await prisma.adminClientAssignment.update({
        where: { admin_id_client_id: { admin_id: admin, client_id: client } },
        data: { is_active: false },
      });
      await expect(
        service.summary(client, { id: admin, role: Role.ADMIN }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // Existing read contract permits inactive clients to preserve internal history.
      await prisma.user.update({
        where: { id: client },
        data: { is_active: false },
      });
      expect((await service.summary(client, actor)).next_task).not.toBeNull();
    });
    it.each(['role', 'assignment'])(
      'rechecks %s revoked while summary waits on authorization locks',
      async (target) => {
        const client = await owner();
        await task(client);
        const blocker = await pool.connect();
        let pending: Promise<unknown> | undefined;
        try {
          await blocker.query('BEGIN');
          if (target === 'role')
            await blocker.query("UPDATE users SET role='CLIENT' WHERE id=$1", [
              admin,
            ]);
          else
            await blocker.query(
              'UPDATE admin_client_assignments SET is_active=false WHERE admin_id=$1 AND client_id=$2',
              [admin, client],
            );
          const {
            rows: [backend],
          } = await blocker.query<{ pid: number }>(
            'SELECT pg_backend_pid() pid',
          );
          pending = service
            .summary(client, { id: admin, role: Role.ADMIN })
            .then(
              (value) => value,
              (error: unknown) => error,
            );
          const deadline = Date.now() + 8000;
          let observed = false;
          while (Date.now() < deadline) {
            const { rows } = await pool.query(
              'SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))',
              [backend.pid],
            );
            if (rows.length) {
              observed = true;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          await blocker.query('COMMIT');
          expect(await pending).toBeInstanceOf(ForbiddenException);
          expect(observed).toBe(true);
        } finally {
          await blocker.query('ROLLBACK');
          blocker.release();
          if (pending) await pending;
          if (target === 'role')
            await prisma.user.update({
              where: { id: admin },
              data: { role: Role.ADMIN },
            });
        }
      },
    );
    it('leaves populated tasks, metrics and users byte-equivalent after repeated reads', async () => {
      const client = await owner();
      await task(client, { type: TaskType.REVIEW });
      await task(client, {
        status: Status.COMPLETED,
        completed_at: new Date(),
      });
      await prisma.bodyMetric.create({
        data: {
          client_id: client,
          date: new Date('2026-10-01'),
          weight_kg: 80,
        },
      });
      const snapshot = async () => ({
        tasks: await prisma.clientFollowUpTask.findMany({
          where: { client_id: client },
          orderBy: { id: 'asc' },
        }),
        metrics: await prisma.bodyMetric.findMany({
          where: { client_id: client },
        }),
        user: await prisma.user.findUnique({ where: { id: client } }),
        assignments: await prisma.adminClientAssignment.findMany({
          where: { client_id: client },
        }),
      });
      const before = await snapshot();
      for (let n = 0; n < 3; n++) await service.summary(client, actor);
      expect(await snapshot()).toEqual(before);
    });
  });
}
