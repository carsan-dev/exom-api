import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ClientFollowUpTaskStatus as Status, Role } from '@prisma/client';
import request from 'supertest';
import { Pool } from 'pg';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { ClientFollowUpTasksModule } from './client-followup-tasks.module';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import * as identity from '../../common/firebase/firebase-id-token';
import { AllExceptionsFilter } from '../../common/filters/http-exception.filter';
import { TransformInterceptor } from '../../common/interceptors/transform.interceptor';
import { assertTestDatabase } from '../../../scripts/test-database.cjs';

interface Display {
  id: string;
  display_name: string | null;
}
interface ListedTask {
  id: string;
  assigned_to_id: string | null;
  assignee: Display | null;
  status: Status;
}
interface Page<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}
function page<T>(response: { body: unknown }): Page<T> {
  // The transport envelope is external JSON, checked through assertions below.
  const body = response.body as { data: Page<T> };
  return body.data;
}
const suite = process.env.FOLLOWUP_HTTP_PG === '1' ? describe : describe.skip;
suite('REST-T2E client task list and assignee lookup (real HTTP/PG)', () => {
  const client = randomUUID();
  const other = randomUUID();
  const admin = randomUUID();
  const outsider = randomUUID();
  const superId = randomUUID();
  const old = randomUUID();
  const staffIds: string[] = [admin, outsider, superId, old];
  let app: INestApplication<Server>;
  let prisma: PrismaService;
  const path = (owner = client, suffix = '') =>
    `/api/v1/admin/clients/${owner}/follow-up-tasks${suffix}`;
  const get = (suffix = '', actor = admin, owner = client) =>
    request(app.getHttpServer())
      .get(path(owner, suffix))
      .set('Authorization', `Bearer ${actor}`);
  const create = (assigned_to_id: string, actor = admin) =>
    request(app.getHttpServer())
      .post(path())
      .set('Authorization', `Bearer ${actor}`)
      .send({
        id: randomUUID(),
        type: 'CALL',
        title: 'Private synthetic task',
        due_date: '2026-10-05',
        assigned_to_id,
      });
  async function fixture(
    owner = client,
    status: Status = Status.PENDING,
    assigned_to_id: string | null = admin,
  ) {
    return prisma.clientFollowUpTask.create({
      data: {
        id: randomUUID(),
        client_id: owner,
        created_by_id: superId,
        assigned_to_id,
        title: 'Internal title',
        description: 'Internal description',
        type: 'CALL',
        due_date: new Date('2026-10-05'),
        priority: 'MEDIUM',
        status,
        completed_at: status === Status.COMPLETED ? new Date() : null,
        cancelled_at: status === Status.CANCELLED ? new Date() : null,
      },
    });
  }
  beforeAll(async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      ssl: false,
    });
    try {
      await assertTestDatabase(pool);
    } finally {
      await pool.end();
    }
    jest
      .spyOn(identity, 'verifyFirebaseIdTokenWithFallback')
      .mockImplementation(({ token }) =>
        [client, other, ...staffIds].includes(token)
          ? Promise.resolve({ uid: token })
          : Promise.reject(new identity.FirebaseIdTokenRejectedError()),
      );
    const testing = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ ignoreEnvFile: true, isGlobal: true }),
        PrismaModule,
        ClientFollowUpTasksModule,
      ],
      providers: [
        { provide: APP_GUARD, useClass: FirebaseAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    }).compile();
    app = testing.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new TransformInterceptor());
    await app.init();
    prisma = app.get(PrismaService);
    await prisma.user.createMany({
      data: [client, other, ...staffIds].map((id) => ({
        id,
        firebase_uid: id,
        email: `${id}@example.test`,
        role:
          id === superId
            ? Role.SUPER_ADMIN
            : staffIds.includes(id)
              ? Role.ADMIN
              : Role.CLIENT,
        is_active: id !== old,
      })),
    });
    await prisma.profile.create({
      data: {
        user_id: admin,
        first_name: 'Assigned',
        last_name: 'Professional',
      },
    });
    await prisma.profile.create({
      data: {
        user_id: old,
        first_name: 'Historical',
        last_name: 'Professional',
      },
    });
    await prisma.adminClientAssignment.createMany({
      data: [admin, old].map((admin_id) => ({ admin_id, client_id: client })),
    });
  });
  afterAll(async () => {
    await app?.close();
    if (prisma && !prisma.postgresqlPool.ended)
      await prisma.postgresqlPool.end();
    jest.restoreAllMocks(); // Owned fixtures/resources retained, never cleaned up.
  });
  it('serves the missing base and static assignees routes as bounded empty pages', async () => {
    expect(page(await get('', superId, other).expect(200))).toEqual({
      data: [],
      total: 0,
      page: 1,
      limit: 20,
      totalPages: 0,
    });
    const result = page<Display>(await get('/assignees', admin).expect(200));
    const superUsers = await prisma.user.findMany({
      where: {
        role: Role.SUPER_ADMIN,
        is_active: true,
        is_locked: false,
        is_archived: false,
        identity_pending: false,
      },
      select: { id: true },
    });
    // Other suites retain synthetic globally eligible SUPER_ADMIN users too.
    expect(result.data.map((row) => row.id).sort()).toEqual(
      [admin, ...superUsers.map((row) => row.id)].sort(),
    );
    expect(result).toMatchObject({
      total: superUsers.length + 1,
      page: 1,
      limit: 20,
      totalPages: 1,
    });
  });
  it('defaults to both active states, exposes history/all/status without assignee-only filtering', async () => {
    for (const status of Object.values(Status))
      await fixture(
        client,
        status,
        status === Status.IN_PROGRESS ? superId : admin,
      );
    const active = page<ListedTask>(await get().expect(200));
    expect(active.total).toBe(2);
    expect(active.data.map((row) => row.status).sort()).toEqual([
      Status.IN_PROGRESS,
      Status.PENDING,
    ]);
    const history = page<ListedTask>(await get('?view=history').expect(200));
    expect(history.data.map((row) => row.status).sort()).toEqual([
      Status.CANCELLED,
      Status.COMPLETED,
    ]);
    expect(page(await get('?view=all').expect(200)).total).toBe(4);
    for (const status of Object.values(Status)) {
      const filtered = page<ListedTask>(
        await get(`?status=${status}`).expect(200),
      );
      expect(filtered.total).toBe(1);
      expect(filtered.data[0].status).toBe(status);
    }
    expect(
      page(await get('?view=active&status=COMPLETED').expect(200)).total,
    ).toBe(0);
  });
  it('paginates totals including beyond-last-page and filters UUID or removed assignee', async () => {
    await fixture(client, Status.PENDING, null);
    const first = page<ListedTask>(await get('?view=all&limit=2').expect(200));
    const second = page<ListedTask>(
      await get('?view=all&limit=2&page=2').expect(200),
    );
    expect(first).toMatchObject({
      total: 5,
      page: 1,
      limit: 2,
      totalPages: 3,
    });
    expect(
      new Set([...first.data, ...second.data].map((row) => row.id)).size,
    ).toBe(4);
    expect(
      page(await get('?view=all&limit=2&page=99').expect(200)),
    ).toMatchObject({ data: [], total: 5, totalPages: 3 });
    expect(
      page(await get(`?view=all&assigned_to_id=${superId}`).expect(200)).total,
    ).toBe(1);
    const removed = page<ListedTask>(
      await get('?assigned_to_id=unassigned').expect(200),
    );
    expect(removed.data).toHaveLength(1);
    expect(removed.data[0]).toMatchObject({
      assigned_to_id: null,
      assignee: null,
    });
    expect(
      page(await get(`?assigned_to_id=${randomUUID()}`).expect(200)).total,
    ).toBe(0);
    const firstOptions = page<Display>(
      await get('/assignees?limit=1').expect(200),
    );
    const lastPage = firstOptions.total + 1;
    const options = page<Display>(
      await get(`/assignees?limit=1&page=${lastPage}`).expect(200),
    );
    expect(options).toEqual({
      data: [],
      total: firstOptions.total,
      page: lastPage,
      limit: 1,
      totalPages: firstOptions.total,
    });
  });
  it('normalizes lowercase, uppercase and mixed-case unassigned sentinel to the same populated rows', async () => {
    const unassigned = await fixture(client, Status.PENDING, null);
    const lowercase = page<ListedTask>(
      await get('?assigned_to_id=unassigned').expect(200),
    );
    expect(lowercase.data.some((row) => row.id === unassigned.id)).toBe(true);
    expect(lowercase.data.every((row) => row.assigned_to_id === null)).toBe(
      true,
    );
    for (const sentinel of ['UNASSIGNED', 'UnAsSiGnEd']) {
      expect(
        page(await get(`?assigned_to_id=${sentinel}`).expect(200)),
      ).toEqual(lowercase);
    }
  });
  it.each([
    'limit=0',
    'limit=101',
    'limit=1.5',
    'limit=abc',
    'limit=1&limit=2',
    'page=0',
    'page=1000001',
    'page=1e30',
    'page=1.2',
    'view=unknown',
    'status=OPEN',
    'assigned_to_id=not-a-uuid',
    'assigned_to_id=null',
    'assigned_to_id=unassigned&assigned_to_id=UNASSIGNED',
    'client_id=forged',
    'created_by_id=forged',
    'sort_by=email',
    'constructor=forged',
  ])('rejects unsupported or forged list query %s', async (query) => {
    await get('?' + query).expect(400);
  });
  it.each([
    'limit=0',
    'limit=101',
    'page=0',
    'status=PENDING',
    'client_id=forged',
    'assigned_to_id=unassigned',
  ])('rejects unsupported assignee query %s', async (query) => {
    await get('/assignees?' + query).expect(400);
  });
  it('uses due, explicit HIGH/MEDIUM/LOW, created and id ordering deterministically', async () => {
    const owner = randomUUID();
    await prisma.user.create({
      data: {
        id: owner,
        firebase_uid: owner,
        email: `${owner}@example.test`,
        role: Role.CLIENT,
      },
    });
    const rows = await Promise.all(
      Array.from({ length: 7 }, () => fixture(owner)),
    );
    const ids = rows.map((row) => row.id).sort();
    for (let i = 0; i < ids.length; i++)
      await prisma.clientFollowUpTask.update({
        where: { id: ids[i] },
        data: {
          due_date: new Date(i === 6 ? '2026-10-04' : '2026-10-05'),
          priority: i < 3 ? 'HIGH' : i < 5 ? 'MEDIUM' : 'LOW',
          created_at: new Date(i === 2 ? '2026-10-01' : '2026-10-02'),
        },
      });
    const result = page<ListedTask>(
      await get('?limit=100', superId, owner).expect(200),
    );
    expect(result.data.map((row) => row.id)).toEqual([
      ids[6],
      ids[2],
      ids[0],
      ids[1],
      ids[3],
      ids[4],
      ids[5],
    ]);
  });
  it.each(['', '/assignees'])(
    'enforces persisted staff scope on %s without cross-client access',
    async (suffix) => {
      await request(app.getHttpServer()).get(path(client, suffix)).expect(401);
      await get(suffix, client).expect(403);
      await get(suffix, outsider).expect(403);
      await get(suffix, admin, other).expect(403);
      await get(suffix, superId, randomUUID()).expect(404);
      await prisma.user.update({
        where: { id: admin },
        data: { is_active: false },
      });
      try {
        await get(suffix).expect(401);
      } finally {
        await prisma.user.update({
          where: { id: admin },
          data: { is_active: true },
        });
      }
    },
  );
  it('displays stale assignee names without offering them, with minimal private-field-free projection', async () => {
    const stale = await fixture(client, Status.COMPLETED, old);
    const result = page<ListedTask>(
      await get(`?view=history&assigned_to_id=${old}`).expect(200),
    );
    expect(result.data[0]).toMatchObject({
      id: stale.id,
      assignee: { id: old, display_name: 'Historical Professional' },
    });
    expect(Object.keys(result.data[0]).sort()).toEqual(
      [
        'id',
        'title',
        'description',
        'type',
        'due_date',
        'priority',
        'status',
        'version',
        'created_at',
        'updated_at',
        'completed_at',
        'cancelled_at',
        'assigned_to_id',
        'assignee',
      ].sort(),
    );
    const options = page<Display>(await get('/assignees').expect(200));
    expect(options.data.some((row) => row.id === old)).toBe(false);
    expect(options.data.find((row) => row.id === admin)).toEqual({
      id: admin,
      display_name: 'Assigned Professional',
    });
    expect(options.data.find((row) => row.id === superId)).toEqual({
      id: superId,
      display_name: null,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /email|firebase|token|created_by_id|client_id|is_locked/,
    );
  });
  it('keeps lookup/save eligibility parity across flags, roles and assignment, including SUPER_ADMIN', async () => {
    for (const role of [Role.ADMIN, Role.SUPER_ADMIN]) {
      for (const flags of [
        {},
        { is_active: false },
        { is_locked: true },
        { is_archived: true },
        { identity_pending: true },
      ]) {
        const id = randomUUID();
        await prisma.user.create({
          data: {
            id,
            firebase_uid: id,
            email: `${id}@example.test`,
            role,
            ...flags,
          },
        });
        if (role === Role.ADMIN)
          await prisma.adminClientAssignment.create({
            data: { admin_id: id, client_id: client },
          });
        const eligible = Object.keys(flags).length === 0;
        const options = page<Display>(
          await get('/assignees?limit=100').expect(200),
        );
        expect(options.data.some((row) => row.id === id)).toBe(eligible);
        await create(id).expect(eligible ? 201 : 403);
        const task = await fixture();
        await request(app.getHttpServer())
          .put(path(client, '/' + task.id))
          .set('Authorization', `Bearer ${admin}`)
          .send({ expected_version: 1, assigned_to_id: id })
          .expect(eligible ? 200 : 403);
      }
    }
    for (const id of [client, outsider, old]) {
      expect(
        page<Display>(await get('/assignees?limit=100').expect(200)).data.some(
          (row) => row.id === id,
        ),
      ).toBe(false);
      await create(id).expect(403);
    }
    await create(superId).expect(201); // Eligible SUPER_ADMIN needs no client assignment.
  });
  it('rejects assignment revoked after lookup on create/update while preserving stale history', async () => {
    const id = randomUUID();
    await prisma.user.create({
      data: {
        id,
        firebase_uid: id,
        email: `${id}@example.test`,
        role: Role.ADMIN,
      },
    });
    await prisma.adminClientAssignment.create({
      data: { admin_id: id, client_id: client },
    });
    expect(
      page<Display>(await get('/assignees?limit=100').expect(200)).data.some(
        (row) => row.id === id,
      ),
    ).toBe(true);
    const task = await fixture();
    await prisma.adminClientAssignment.update({
      where: { admin_id_client_id: { admin_id: id, client_id: client } },
      data: { is_active: false },
    });
    await create(id).expect(403);
    await request(app.getHttpServer())
      .put(path(client, '/' + task.id))
      .set('Authorization', `Bearer ${admin}`)
      .send({ expected_version: 1, assigned_to_id: id })
      .expect(403);
    expect(
      await prisma.clientFollowUpTask.findUniqueOrThrow({
        where: { id: task.id },
      }),
    ).toEqual(task);
  });
  it('returns a coherent total/page while a table-lock-blocked read overlaps a committed insert', async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      ssl: false,
    });
    await assertTestDatabase(pool);
    const blocker = await pool.connect();
    let reading: Promise<request.Response> | undefined;
    const before = await prisma.clientFollowUpTask.count({
      where: { client_id: other },
    });
    const inserted = randomUUID();
    try {
      await blocker.query('BEGIN');
      const identity = await blocker.query<{ pid: number }>(
        'SELECT pg_backend_pid() AS pid',
      );
      await blocker.query(
        'LOCK TABLE client_followup_tasks IN ACCESS EXCLUSIVE MODE',
      );
      await blocker.query(
        `INSERT INTO client_followup_tasks
          (id, client_id, title, type, due_date, updated_at)
          VALUES ($1, $2, $3, 'CALL', '2026-10-05', now())`,
        [inserted, other, 'Concurrent synthetic task'],
      );
      reading = get('?view=all&limit=100', superId, other).then(
        (response) => response,
      );
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const waiting = await pool.query<{ blocked: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM pg_stat_activity
            WHERE $1 = ANY(pg_blocking_pids(pid))
              AND query LIKE '%WITH filtered AS NOT MATERIALIZED%') AS blocked`,
          [identity.rows[0].pid],
        );
        if (waiting.rows[0].blocked) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(blocked).toBe(true); // Observed interleaving, not concurrent-launch inference.
      await blocker.query('COMMIT');
      const response = await reading;
      expect(response.status).toBe(200);
      const result = page<ListedTask>(response);
      expect([before, before + 1]).toContain(result.total);
      expect(result.data).toHaveLength(result.total);
      expect(result.data.some((row) => row.id === inserted)).toBe(
        result.total === before + 1,
      );
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      if (reading) await reading;
      await pool.end();
    }
  });
  it('reads populated rows without writes and leaves canonical summary unchanged', async () => {
    const before = await prisma.clientFollowUpTask.findMany({
      where: { client_id: client },
      orderBy: { id: 'asc' },
    });
    const users = await prisma.user.findMany({
      where: { id: { in: [client, admin, superId] } },
    });
    const assignments = await prisma.adminClientAssignment.findMany({
      where: { client_id: client },
      orderBy: { id: 'asc' },
    });
    const summary = page(await get('/summary').expect(200));
    await get('?view=all&limit=100').expect(200);
    await get('/assignees?limit=100').expect(200);
    expect(page(await get('/summary').expect(200))).toEqual(summary);
    expect(
      await prisma.clientFollowUpTask.findMany({
        where: { client_id: client },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(before);
    expect(
      await prisma.user.findMany({
        where: { id: { in: [client, admin, superId] } },
      }),
    ).toEqual(users);
    expect(
      await prisma.adminClientAssignment.findMany({
        where: { client_id: client },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(assignments);
  });
});
