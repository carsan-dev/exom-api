import { randomUUID } from 'node:crypto';
import { Pool, PoolClient } from 'pg';
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  ClientFollowUpTaskStatus,
  ClientFollowUpTaskType,
  Role,
} from '@prisma/client';
import { assertTestDatabase } from '../../../scripts/test-database.cjs';
import { PrismaService } from '../../prisma/prisma.service';
import { ClientFollowUpTasksService } from './client-followup-tasks.service';

const suite =
  process.env.FOLLOWUP_SERVICE_PG === '1' ? describe : describe.skip;
suite('REST-T2B real PostgreSQL service', () => {
  const prefix = `t2b-${randomUUID()}`;
  const client = prefix + '-client';
  const other = prefix + '-other';
  const admin = prefix + '-admin';
  const assignee = prefix + '-assignee';
  const superId = prefix + '-super';
  const actor = { id: superId, role: Role.SUPER_ADMIN };
  let prisma: PrismaService;
  let service: ClientFollowUpTasksService;
  let pool: Pool;
  const input = () => ({
    id: randomUUID(),
    title: 'Call',
    type: ClientFollowUpTaskType.CALL,
    due_date: '2026-10-05',
  });
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
      data: [client, other, admin, assignee, superId].map((id) => ({
        id,
        firebase_uid: id,
        email: `${id}@example.test`,
        role:
          id === superId
            ? Role.SUPER_ADMIN
            : [admin, assignee].includes(id)
              ? Role.ADMIN
              : Role.CLIENT,
      })),
    });
    await prisma.adminClientAssignment.createMany({
      data: [admin, assignee].map((admin_id) => ({
        admin_id,
        client_id: client,
      })),
    });
    await prisma.bodyMetric.create({
      data: { client_id: client, date: new Date('2026-10-01'), weight_kg: 80 },
    });
  });
  afterAll(async () => {
    // Retain all fixtures and the owned cluster; disconnect only test clients.
    await prisma?.$disconnect();
    if (prisma && !prisma.postgresqlPool.ended)
      await prisma.postgresqlPool.end();
    await pool?.end();
  });
  async function blocked(blocker: PoolClient, count = 1) {
    const {
      rows: [identity],
    } = await blocker.query<{ pid: number }>('SELECT pg_backend_pid() pid');
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const { rows } = await pool.query(
        'SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))',
        [identity.pid],
      );
      if (rows.length >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('Required forced interleaving not observed');
  }
  async function barrier(work: () => Promise<void>) {
    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`exom:day-progress:${client}`],
      );
      const outcome = work().then(
        () => null,
        (error: unknown) => error,
      );
      await blocked(blocker, 2);
      await blocker.query('COMMIT');
      const error = await outcome;
      if (error instanceof Error) throw error;
      if (error) throw new Error('Barrier work failed');
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
  }
  it('allows assigned ADMIN and SUPER_ADMIN, denies client/unassigned and ineligible staff/assignee', async () => {
    const task = await service.create(
      client,
      { ...input(), assigned_to_id: assignee },
      { id: admin, role: Role.ADMIN },
    );
    await expect(service.get(client, task.id, actor)).resolves.toHaveProperty(
      'id',
      task.id,
    );
    await expect(
      service.get(client, task.id, { id: client, role: Role.CLIENT }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.get(other, task.id, { id: admin, role: Role.ADMIN }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.get(other, task.id, actor)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    for (const field of [
      'is_active',
      'is_locked',
      'is_archived',
      'identity_pending',
    ] as const) {
      for (const id of [admin, superId]) {
        await prisma.user.update({
          where: { id },
          data: { [field]: field !== 'is_active' },
        });
        await expect(
          service.get(client, task.id, {
            id,
            role: id === admin ? Role.ADMIN : Role.SUPER_ADMIN,
          }),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(
          service.create(
            client,
            { ...input(), assigned_to_id: id },
            id === superId ? { id: admin, role: Role.ADMIN } : actor,
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await prisma.user.update({
          where: { id },
          data: { [field]: field === 'is_active' },
        });
      }
    }
    await expect(
      service.create(client, { ...input(), assigned_to_id: client }, actor),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.create(other, { ...input(), assigned_to_id: admin }, actor),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
  it.each(['actor', 'role', 'assignee', 'owner', 'assignment'])(
    'rechecks %s revocation committed while service waits',
    async (target) => {
      const blocker = await pool.connect();
      const task = await service.create(client, input(), actor);
      let pending: Promise<unknown> | undefined;
      try {
        await blocker.query('BEGIN');
        if (target === 'assignment')
          await blocker.query(
            'UPDATE admin_client_assignments SET is_active=false WHERE client_id=$1 AND admin_id=$2',
            [client, admin],
          );
        else if (target === 'role')
          await blocker.query("UPDATE users SET role='CLIENT' WHERE id=$1", [
            admin,
          ]);
        else
          await blocker.query('UPDATE users SET is_active=false WHERE id=$1', [
            target === 'actor' ? admin : target === 'owner' ? client : assignee,
          ]);
        pending = service
          .update(
            client,
            task.id,
            { expected_version: 1, assigned_to_id: assignee },
            { id: admin, role: Role.ADMIN },
          )
          .then(
            (value) => value,
            (error: unknown) => error,
          );
        await blocked(blocker);
        await blocker.query('COMMIT');
        expect(await pending).toBeInstanceOf(ForbiddenException);
        expect(
          await prisma.clientFollowUpTask.findUniqueOrThrow({
            where: { id: task.id },
          }),
        ).toMatchObject({ version: 1, title: 'Call' });
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
        if (pending) await pending;
        await prisma.user.updateMany({
          where: { id: { in: [client, admin, assignee] } },
          data: { is_active: true },
        });
        await prisma.user.update({
          where: { id: admin },
          data: { role: Role.ADMIN },
        });
        await prisma.adminClientAssignment.updateMany({
          where: { client_id: client },
          data: { is_active: true },
        });
      }
    },
  );
  it('holds authorization locks through commit, blocking a later role writer', async () => {
    const task = await service.create(client, input(), actor);
    const blocker = await pool.connect();
    const writer = await pool.connect();
    let writing: Promise<unknown> | undefined;
    let updating: Promise<unknown> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query(
        'SELECT id FROM client_followup_tasks WHERE id=$1 FOR UPDATE',
        [task.id],
      );
      updating = service.update(
        client,
        task.id,
        { expected_version: 1, title: 'Authorized' },
        { id: admin, role: Role.ADMIN },
      );
      const result = updating.then(
        (value) => value,
        (error: unknown) => error,
      );
      await blocked(blocker);
      await writer.query('BEGIN');
      const {
        rows: [identity],
      } = await writer.query<{ pid: number }>('SELECT pg_backend_pid() pid');
      writing = writer.query("UPDATE users SET role='CLIENT' WHERE id=$1", [
        admin,
      ]);
      const written = writing.then(
        () => null,
        (error: unknown) => error,
      );
      const deadline = Date.now() + 8000;
      let observed = false;
      while (Date.now() < deadline) {
        const { rows } = await pool.query<{ blocked: boolean }>(
          'SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked',
          [identity.pid],
        );
        if (rows[0].blocked) {
          observed = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(observed).toBe(true);
      await blocker.query('COMMIT');
      expect(await result).toMatchObject({ version: 2, title: 'Authorized' });
      expect(await written).toBeNull();
      await writer.query('COMMIT');
      await expect(
        service.get(client, task.id, { id: admin, role: Role.ADMIN }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    } finally {
      await blocker.query('ROLLBACK');
      await writer.query('ROLLBACK');
      blocker.release();
      writer.release();
      await prisma.user.update({
        where: { id: admin },
        data: { role: Role.ADMIN },
      });
    }
  });
  it('serializes forced same-version contenders to one winner and one conflict', async () => {
    const task = await service.create(client, input(), actor);
    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`exom:day-progress:${client}`],
      );
      const contenders = ['First', 'Second'].map((title) =>
        service
          .update(client, task.id, { expected_version: 1, title }, actor)
          .then(
            (value) => value,
            (error: unknown) => error,
          ),
      );
      await blocked(blocker, 2);
      await blocker.query('COMMIT');
      const outcomes = await Promise.all(contenders);
      expect(
        outcomes.filter((value) => value instanceof ConflictException),
      ).toHaveLength(1);
      const persisted = await service.get(client, task.id, actor);
      expect(persisted.version).toBe(2);
      expect(['First', 'Second']).toContain(persisted.title);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
  });
  it('forced duplicate create replays one row; payload, creator and owner collisions conflict', async () => {
    const payload = input();
    await barrier(async () => {
      const results = await Promise.all([
        service.create(client, payload, actor),
        service.create(client, payload, actor),
      ]);
      expect(results[0]).toEqual(results[1]);
    });
    expect(
      await prisma.clientFollowUpTask.count({ where: { id: payload.id } }),
    ).toBe(1);
    await expect(
      service.create(client, { ...payload, title: 'Different' }, actor),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      service.create(
        client,
        { ...payload, assigned_to_id: superId },
        { id: admin, role: Role.ADMIN },
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(service.create(other, payload, actor)).rejects.toBeInstanceOf(
      ConflictException,
    );
    await expect(
      service.update(other, payload.id, { expected_version: 1 }, actor),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
  it.each([
    ClientFollowUpTaskStatus.COMPLETED,
    ClientFollowUpTaskStatus.CANCELLED,
  ])(
    'closed %s task is immutable with timestamps, retaining history without other effects',
    async (status) => {
      const task = await service.create(client, input(), actor);
      const { rows: tables } = await pool.query<{ tablename: string }>(
        "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> 'client_followup_tasks' ORDER BY tablename",
      );
      async function snapshot() {
        const result: Record<string, unknown> = {};
        for (const { tablename } of tables) {
          const identifier = '"' + tablename.replaceAll('"', '""') + '"';
          const { rows } = await pool.query<{ contents: unknown }>(
            `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::jsonb) contents FROM ${identifier} t`,
          );
          result[tablename] = rows[0].contents;
        }
        return result;
      }
      const before = await snapshot();
      const closed = await service.update(
        client,
        task.id,
        { expected_version: 1, status },
        actor,
      );
      expect(closed.version).toBe(2);
      expect(
        status === ClientFollowUpTaskStatus.COMPLETED
          ? closed.completed_at
          : closed.cancelled_at,
      ).toBeInstanceOf(Date);
      await expect(
        service.update(
          client,
          task.id,
          { expected_version: 2, title: 'Forbidden' },
          actor,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(await snapshot()).toEqual(before);
      await prisma.user.update({
        where: { id: client },
        data: { is_archived: true },
      });
      await expect(service.get(client, task.id, actor)).resolves.toEqual(
        closed,
      );
      await expect(
        service.create(client, input(), actor),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await prisma.user.update({
        where: { id: client },
        data: { is_archived: false },
      });
    },
  );
  it('rejects overflow without mutation and preserves null historical assignee', async () => {
    const task = await service.create(client, input(), actor);
    await prisma.clientFollowUpTask.update({
      where: { id: task.id },
      data: { version: 2147483647, assigned_to_id: null },
    });
    await expect(
      service.update(client, task.id, { expected_version: 2147483647 }, actor),
    ).rejects.toBeInstanceOf(ConflictException);
    await prisma.clientFollowUpTask.update({
      where: { id: task.id },
      data: { version: 1 },
    });
    await expect(
      service.update(client, task.id, { expected_version: 1 }, actor),
    ).resolves.toMatchObject({ version: 2, assigned_to_id: null });
  });
});
