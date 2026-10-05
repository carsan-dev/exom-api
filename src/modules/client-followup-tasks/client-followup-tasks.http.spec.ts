import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { INestApplication, Module, Type, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { Role } from '@prisma/client';
import request from 'supertest';
import { Pool } from 'pg';
import { AppModule } from '../../app.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import * as identity from '../../common/firebase/firebase-id-token';
import { AllExceptionsFilter } from '../../common/filters/http-exception.filter';
import { TransformInterceptor } from '../../common/interceptors/transform.interceptor';
import { assertTestDatabase } from '../../../scripts/test-database.cjs';

// Bootable RED: absence of production wiring means real HTTP 404, not import failure.
@Module({})
class MissingRoutesModule {}
const metadata: unknown = Reflect.getMetadata(
  MODULE_METADATA.IMPORTS,
  AppModule,
);
const modules: unknown[] = Array.isArray(metadata) ? metadata : [];
const taskModule =
  modules.find(
    (entry): entry is Type<unknown> =>
      typeof entry === 'function' && entry.name === 'ClientFollowUpTasksModule',
  ) ?? MissingRoutesModule;
const suite = process.env.FOLLOWUP_HTTP_PG === '1' ? describe : describe.skip;

function responseData(response: { body: unknown }): Record<string, unknown> {
  const body = response.body;
  if (!body || typeof body !== 'object' || !('data' in body)) {
    throw new Error('Missing response envelope');
  }
  if (!body.data || typeof body.data !== 'object') {
    throw new Error('Missing task response');
  }
  return Object.fromEntries(Object.entries(body.data));
}

suite('REST-T2C manual task HTTP with real guards and PostgreSQL', () => {
  const prefix = `t2c-${randomUUID()}`;
  const client = prefix + '-client';
  const other = prefix + '-other';
  const admin = prefix + '-admin';
  const outsider = prefix + '-outsider';
  const superId = prefix + '-super';
  let app: INestApplication<Server>;
  let prisma: PrismaService;
  const input = () => ({
    id: randomUUID(),
    type: 'CALL',
    title: ' Call ',
    due_date: '2026-10-05',
  });
  const path = (owner = client, id?: string) =>
    `/api/v1/admin/clients/${owner}/follow-up-tasks${id ? '/' + id : ''}`;
  function post(body: unknown, actor = superId, owner = client) {
    return request(app.getHttpServer())
      .post(path(owner))
      .set('Authorization', `Bearer ${actor}`)
      .type('json')
      .send(JSON.stringify(body));
  }
  function put(id: string, body: unknown, actor = superId, owner = client) {
    return request(app.getHttpServer())
      .put(path(owner, id))
      .set('Authorization', `Bearer ${actor}`)
      .type('json')
      .send(JSON.stringify(body));
  }
  function get(id: string, actor = superId, owner = client) {
    return request(app.getHttpServer())
      .get(path(owner, id))
      .set('Authorization', `Bearer ${actor}`);
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
      .mockImplementation(({ token }) => {
        if (![client, other, admin, outsider, superId].includes(token))
          return Promise.reject(new identity.FirebaseIdTokenRejectedError());
        return Promise.resolve({ uid: token });
      });
    const testing = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ ignoreEnvFile: true, isGlobal: true }),
        PrismaModule,
        taskModule,
      ],
      providers: [
        { provide: APP_GUARD, useClass: FirebaseAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    }).compile();
    app = testing.createNestApplication();
    app.setGlobalPrefix('api/v1');
    // Exact production pipe options, including implicit conversion.
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
      data: [client, other, admin, outsider, superId].map((id) => ({
        id,
        firebase_uid: id,
        email: `${id}@example.test`,
        role:
          id === superId
            ? Role.SUPER_ADMIN
            : [admin, outsider].includes(id)
              ? Role.ADMIN
              : Role.CLIENT,
      })),
    });
    await prisma.adminClientAssignment.create({
      data: { admin_id: admin, client_id: client },
    });
  });
  afterAll(async () => {
    await app?.close();
    if (prisma && !prisma.postgresqlPool.ended)
      await prisma.postgresqlPool.end();
    jest.restoreAllMocks(); // Fixtures retained; no live Firebase or cleanup.
  });
  it('enforces authentication and staff role before service writes', async () => {
    const body = input();
    await request(app.getHttpServer()).post(path()).send(body).expect(401);
    await post(body, 'invalid-identity').expect(401);
    await post(body, client).expect(403);
    await post(body, outsider).expect(403);
    expect(
      await prisma.clientFollowUpTask.count({ where: { id: body.id } }),
    ).toBe(0);
  });
  it('creates as assigned ADMIN, returns server-owned fields and GET is read-only', async () => {
    const body = input();
    const created = await post(body, admin).expect(201);
    expect(responseData(created)).toMatchObject({
      id: body.id,
      client_id: client,
      created_by_id: admin,
      assigned_to_id: admin,
      title: 'Call',
      status: 'PENDING',
      priority: 'MEDIUM',
      version: 1,
      due_date: '2026-10-05T00:00:00.000Z',
    });
    const before = await prisma.clientFollowUpTask.findUniqueOrThrow({
      where: { id: body.id },
    });
    await get(body.id, admin).expect(200);
    expect(
      await prisma.clientFollowUpTask.findUniqueOrThrow({
        where: { id: body.id },
      }),
    ).toEqual(before);
    await get(body.id, outsider).expect(403);
    await get(body.id, admin, other).expect(403);
    await get(body.id, superId, other).expect(404);
    await put(
      body.id,
      { expected_version: 1, title: 'Cross owner' },
      superId,
      other,
    ).expect(404);
    expect(
      await prisma.clientFollowUpTask.findUniqueOrThrow({
        where: { id: body.id },
      }),
    ).toEqual(before);
  });
  it('replays normalized create payload, rejects mismatched creator/payload/owner', async () => {
    const body = { ...input(), description: ' Note\r\nline ' };
    const first = await post(body).expect(201);
    const replay = await post({
      ...body,
      id: body.id.toUpperCase(),
      title: 'Call',
      description: 'Note\nline',
    }).expect(201);
    expect(responseData(replay)).toEqual(responseData(first));
    await post({ ...body, title: 'Changed' }).expect(409);
    await post(body, admin).expect(409);
    await post(body, superId, other).expect(409);
    expect(
      await prisma.clientFollowUpTask.count({ where: { id: body.id } }),
    ).toBe(1);
  });
  it('updates allowed fields, clears only description with null and protects version/closed history', async () => {
    const body = input();
    await post(body).expect(201);
    const edited = await put(body.id, {
      expected_version: 1,
      description: 'Note',
      type: 'REVIEW',
      priority: 'HIGH',
      assigned_to_id: admin,
      status: 'IN_PROGRESS',
      due_date: '2026-10-06',
    }).expect(200);
    expect(responseData(edited)).toMatchObject({
      version: 2,
      status: 'IN_PROGRESS',
      assigned_to_id: admin,
      description: 'Note',
    });
    await put(body.id, { expected_version: 1, title: 'Stale' }).expect(409);
    await put(body.id, {
      expected_version: 2,
      assigned_to_id: outsider,
    }).expect(403);
    await put(body.id, { expected_version: 2, assigned_to_id: other }).expect(
      403,
    );
    const closed = await put(body.id, {
      expected_version: 2,
      description: null,
      status: 'COMPLETED',
    }).expect(200);
    expect(responseData(closed)).toMatchObject({
      version: 3,
      description: null,
      status: 'COMPLETED',
      cancelled_at: null,
    });
    expect(responseData(closed).completed_at).not.toBeNull();
    const stored = await prisma.clientFollowUpTask.findUniqueOrThrow({
      where: { id: body.id },
    });
    await put(body.id, { expected_version: 3, status: 'PENDING' }).expect(409);
    await post(body).expect(409);
    await get(body.id).expect(200);
    expect(
      await prisma.clientFollowUpTask.findUniqueOrThrow({
        where: { id: body.id },
      }),
    ).toEqual(stored);
  });
  it('cancels without reopening and preserves omitted optional fields', async () => {
    const body = { ...input(), description: 'retain' };
    await post(body).expect(201);
    const closed = await put(body.id, {
      expected_version: 1,
      status: 'CANCELLED',
    }).expect(200);
    expect(responseData(closed)).toMatchObject({
      description: 'retain',
      version: 2,
      completed_at: null,
    });
    expect(responseData(closed).cancelled_at).not.toBeNull();
    await put(body.id, { expected_version: 2, title: 'Edit closed' }).expect(
      409,
    );
  });
  it('classifies exactly one concurrent HTTP version winner and leaves loser unapplied', async () => {
    const body = input();
    await post(body).expect(201);
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      ssl: false,
    });
    await assertTestDatabase(pool);
    const blocker = await pool.connect();
    let results: request.Response[];
    try {
      await blocker.query('BEGIN');
      await blocker.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`exom:day-progress:${client}`],
      );
      const {
        rows: [backend],
      } = await blocker.query<{ pid: number }>('SELECT pg_backend_pid() pid');
      const pending = Promise.all(
        ['Winner A', 'Winner B'].map((title) =>
          put(body.id, { expected_version: 1, title }).then((result) => result),
        ),
      );
      const deadline = Date.now() + 8000;
      let observed = false;
      while (Date.now() < deadline) {
        const { rows } = await pool.query<{ pid: number; blockers: number[] }>(
          'SELECT pid, pg_blocking_pids(pid) blockers FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))',
          [backend.pid],
        );
        if (rows.length === 2) {
          console.log('HTTP version contenders blocked', rows);
          observed = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await blocker.query('COMMIT');
      results = await pending;
      expect(observed).toBe(true);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      await pool.end();
    }
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    const winner = results.find((result) => result.status === 200)!;
    const stored = await prisma.clientFollowUpTask.findUniqueOrThrow({
      where: { id: body.id },
    });
    expect(stored.version).toBe(2);
    expect(stored.title).toBe(responseData(winner).title);
  });
  it.each([
    'client_id',
    'created_by_id',
    'version',
    'completed_at',
    'cancelled_at',
    'unexpected',
    '__proto__',
    'constructor',
  ])('rejects forged or unknown %s on both commands', async (field) => {
    const body = input();
    await post(
      JSON.parse(
        JSON.stringify(body).slice(0, -1) +
          `,${JSON.stringify(field)}:"forged"}`,
      ),
    ).expect(400);
    await post(body).expect(201);
    await put(body.id, { expected_version: 1, [field]: 'forged' }).expect(400);
    expect(
      (
        await prisma.clientFollowUpTask.findUniqueOrThrow({
          where: { id: body.id },
        })
      ).version,
    ).toBe(1);
  });
  it('rejects server-owned status on create but allows validated status commands', async () => {
    await post({ ...input(), status: 'COMPLETED' }).expect(400);
  });
  it.each([
    { id: 'not-uuid' },
    { id: null },
    { type: 'UNKNOWN' },
    { type: null },
    { title: '' },
    { title: '   ' },
    { title: 42 },
    { title: null },
    { title: 'x'.repeat(161) },
    { due_date: '2026-02-30' },
    { due_date: '0000-01-01' },
    { due_date: '2026-10-05T00:00:00Z' },
    { due_date: null },
    { description: 42 },
    { description: 'x'.repeat(3001) },
    { priority: null },
    { priority: 'UNKNOWN' },
    { assigned_to_id: null },
    { assigned_to_id: '' },
  ])('rejects invalid create %j without persistence', async (invalid) => {
    const body = { ...input(), ...invalid };
    await post(body).expect(400);
    if (typeof body.id === 'string')
      expect(
        await prisma.clientFollowUpTask.count({ where: { id: body.id } }),
      ).toBe(0);
  });
  it.each([
    {},
    { expected_version: null },
    { expected_version: 0 },
    { expected_version: 1.5 },
    { expected_version: 2147483648 },
    { expected_version: '1' },
    { expected_version: 1, title: null },
    { expected_version: 1, title: 42 },
    { expected_version: 1, status: null },
    { expected_version: 1, status: 'UNKNOWN' },
    { expected_version: 1, due_date: '2026-02-30' },
  ])('rejects invalid update %j without mutation', async (invalid) => {
    const body = input();
    await post(body).expect(201);
    const before = await prisma.clientFollowUpTask.findUniqueOrThrow({
      where: { id: body.id },
    });
    await put(body.id, invalid).expect(400);
    expect(
      await prisma.clientFollowUpTask.findUniqueOrThrow({
        where: { id: body.id },
      }),
    ).toEqual(before);
  });
  it('requires create fields and returns scoped missing task/client results', async () => {
    for (const key of ['id', 'title', 'type', 'due_date']) {
      const body: Record<string, unknown> = input();
      delete body[key];
      await post(body).expect(400);
    }
    await get(randomUUID()).expect(404);
    await post(input(), superId, prefix + '-missing').expect(404);
  });
});
