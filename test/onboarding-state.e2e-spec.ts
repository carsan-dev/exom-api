import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import type { ExecutionContext } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { OpenAPIObject } from '@nestjs/swagger';
import Ajv from 'ajv';
import { Pool } from 'pg';
import request from 'supertest';
import type { Request } from 'express';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import { createOpenApiDocument } from '../src/openapi';
import { FirebaseAuthGuard } from '../src/common/guards/firebase-auth.guard';
import { PrismaService } from '../src/prisma/prisma.service';
import { databaseUrl, verifyDatabase } from '../scripts/test-database.cjs';

// Persistent onboarding state (plan OP-RED-06/07, OP-API-02..09, OP-CMP-02).
// Only Firebase identity verification is substituted; HTTP, role guards,
// validation, interceptors, services, SQL and serialization are real.
// Rows are read with plain SQL so this suite compiles against the base schema
// and fails there on behaviour (missing route / missing keys), not on types.
describe('Persistent onboarding state over HTTP and PostgreSQL', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let pool: Pool;
  let document: OpenAPIObject;
  const ids = {
    superAdmin: randomUUID(),
    admin: randomUUID(),
    first: randomUUID(),
    absent: randomUUID(),
    explicitNull: randomUUID(),
    invalid: randomUUID(),
    noProfile: randomUUID(),
    legacyPut: randomUUID(),
    adminPatched: randomUUID(),
  };
  const known: string[] = Object.values(ids);
  const roles: Record<string, 'SUPER_ADMIN' | 'ADMIN' | 'CLIENT'> = {
    [ids.superAdmin]: 'SUPER_ADMIN',
    [ids.admin]: 'ADMIN',
  };
  const route = '/api/v1/profile/me/onboarding';
  const server = () => app.getHttpServer();
  const as = (id: string) => ({ 'x-onboarding-owner': id });

  beforeAll(async () => {
    databaseUrl();
    await verifyDatabase();
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication<NestExpressApplication>();
    prisma = app.get(PrismaService);
    const originalGuard = new FirebaseAuthGuard(
      app.get(Reflector),
      prisma,
      app.get(ConfigService),
    );
    jest.spyOn(originalGuard, 'canActivate');
    jest
      .spyOn(FirebaseAuthGuard.prototype, 'canActivate')
      .mockImplementation(function (
        this: FirebaseAuthGuard,
        context: ExecutionContext,
      ) {
        const req = context
          .switchToHttp()
          .getRequest<Request & { user?: unknown }>();
        const identity = req.headers['x-onboarding-owner'];
        if (typeof identity === 'string' && known.includes(identity)) {
          req.user = {
            id: identity,
            email: `${identity}@example.test`,
            firebase_uid: identity,
            role: roles[identity] ?? 'CLIENT',
          };
          return Promise.resolve(true);
        }
        // Anonymous requests still execute the real guard (401).
        return originalGuard.canActivate(context);
      });
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    document = createOpenApiDocument(app);
    pool = new Pool({ connectionString: databaseUrl() });
    for (const id of Object.values(ids)) {
      await prisma.user.create({
        data: {
          id,
          firebase_uid: id,
          email: `${id}@example.test`,
          role: roles[id] ?? 'CLIENT',
        },
      });
      if (id !== ids.noProfile) {
        await prisma.profile.create({
          data: {
            user_id: id,
            first_name: 'Onboarding',
            last_name: 'Fixture',
            main_goal: 'Fuerza',
            current_weight: 72.5,
          },
        });
      }
    }
  });

  afterAll(async () => {
    try {
      if (prisma) {
        await prisma.user.deleteMany({
          where: { id: { in: Object.values(ids) } },
        });
      }
    } finally {
      jest.restoreAllMocks();
      if (pool) await pool.end();
      if (app) await app.close();
    }
  });

  function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw Error('Expected object');
    return Object.fromEntries(Object.entries(value));
  }
  function data(response: { body: unknown }): Record<string, unknown> {
    return record(record(response.body).data);
  }
  async function row(userId: string): Promise<Record<string, unknown> | null> {
    const result = await pool.query<{ image: Record<string, unknown> }>(
      'SELECT to_jsonb(p) AS image FROM profiles p WHERE user_id = $1',
      [userId],
    );
    return result.rows[0]?.image ?? null;
  }
  async function requireRow(userId: string): Promise<Record<string, unknown>> {
    const image = await row(userId);
    if (!image) throw Error('Expected profile row');
    return image;
  }
  // to_jsonb renders TIMESTAMP(3) without zone; Prisma stores those as UTC.
  function rowInstant(value: unknown): number {
    if (typeof value !== 'string') throw Error('Expected timestamp text');
    return Date.parse(`${value}Z`);
  }
  function withoutOnboarding(image: Record<string, unknown>) {
    return Object.fromEntries(
      Object.entries(image).filter(
        ([key]) =>
          key !== 'onboarding_completed_at' &&
          key !== 'onboarding_outcome' &&
          key !== 'updated_at',
      ),
    );
  }
  function validateResponse(path: string, value: unknown) {
    const operation = document.paths[path].post!;
    const response = operation.responses['200'];
    if (!response || '$ref' in response) throw Error('Missing 200 response');
    const schema = response.content?.['application/json'].schema ?? {};
    const ajv = new Ajv({
      allErrors: true,
      nullable: true,
      unknownFormats: 'ignore',
    });
    const check = ajv.compile({ ...schema, components: document.components });
    expect({ valid: check(value), errors: check.errors }).toEqual({
      valid: true,
      errors: null,
    });
  }

  it('exposes both onboarding keys as null in /auth/me and /profile/me before any mark', async () => {
    const me = await request(server())
      .get('/api/v1/auth/me')
      .set(as(ids.first))
      .expect(200);
    const profile = record(data(me).profile);
    expect(profile).toHaveProperty('onboarding_completed_at', null);
    expect(profile).toHaveProperty('onboarding_outcome', null);
    const own = await request(server())
      .get('/api/v1/profile/me')
      .set(as(ids.first))
      .expect(200);
    expect(data(own)).toHaveProperty('onboarding_completed_at', null);
    expect(data(own)).toHaveProperty('onboarding_outcome', null);
  });

  it('first POST stores the date and outcome and returns 200 with both', async () => {
    const before = await requireRow(ids.first);
    const started = Date.now();
    const response = await request(server())
      .post(route)
      .set(as(ids.first))
      .send({ outcome: 'COMPLETED' })
      .expect(200);
    validateResponse(route, response.body);
    const body = data(response);
    expect(Object.keys(body).sort()).toEqual([
      'onboarding_completed_at',
      'onboarding_outcome',
    ]);
    expect(body.onboarding_outcome).toBe('COMPLETED');
    expect(typeof body.onboarding_completed_at).toBe('string');
    const stamp = Date.parse(String(body.onboarding_completed_at));
    expect(stamp).toBeGreaterThanOrEqual(started - 1000);
    const after = await requireRow(ids.first);
    expect(after.onboarding_outcome).toBe('COMPLETED');
    expect(rowInstant(after.onboarding_completed_at)).toBe(stamp);
    expect(withoutOnboarding(after)).toEqual(withoutOnboarding(before));
    const me = await request(server())
      .get('/api/v1/auth/me')
      .set(as(ids.first))
      .expect(200);
    const profile = record(data(me).profile);
    expect(profile.onboarding_outcome).toBe('COMPLETED');
    expect(Date.parse(String(profile.onboarding_completed_at))).toBe(stamp);
    const own = await request(server())
      .get('/api/v1/profile/me')
      .set(as(ids.first))
      .expect(200);
    expect(data(own).onboarding_outcome).toBe('COMPLETED');
    expect(Date.parse(String(data(own).onboarding_completed_at))).toBe(stamp);
  });

  it('a retry with another outcome returns the original winner and changes no column', async () => {
    const before = await requireRow(ids.first);
    const retry = await request(server())
      .post(route)
      .set(as(ids.first))
      .send({ outcome: 'SKIPPED' })
      .expect(200);
    expect(data(retry).onboarding_outcome).toBe('COMPLETED');
    expect(Date.parse(String(data(retry).onboarding_completed_at))).toBe(
      rowInstant(before.onboarding_completed_at),
    );
    const empty = await request(server())
      .post(route)
      .set(as(ids.first))
      .send({})
      .expect(200);
    expect(data(empty)).toEqual(data(retry));
    expect(await requireRow(ids.first)).toEqual(before);
  });

  it.each([
    ['absent', () => ids.absent, {}],
    ['explicit null', () => ids.explicitNull, { outcome: null }],
  ])(
    'stores an unknown (NULL) outcome when it is %s',
    async (_label, id, body) => {
      const response = await request(server())
        .post(route)
        .set(as(id()))
        .send(body)
        .expect(200);
      expect(data(response).onboarding_outcome).toBeNull();
      expect(typeof data(response).onboarding_completed_at).toBe('string');
      const after = await requireRow(id());
      expect(after.onboarding_outcome).toBeNull();
      expect(after.onboarding_completed_at).not.toBeNull();
    },
  );

  it('rejects invalid outcomes, extra properties and anonymous calls without writing', async () => {
    const before = await requireRow(ids.invalid);
    await request(server())
      .post(route)
      .set(as(ids.invalid))
      .send({ outcome: 'DONE' })
      .expect(400);
    await request(server())
      .post(route)
      .set(as(ids.invalid))
      .send({ outcome: 'COMPLETED', onboarding_completed_at: new Date() })
      .expect(400);
    await request(server())
      .post(route)
      .send({ outcome: 'COMPLETED' })
      .expect(401);
    expect(await requireRow(ids.invalid)).toEqual(before);
    expect(before.onboarding_completed_at).toBeNull();
  });

  it.each([
    ['ADMIN', () => ids.admin],
    ['SUPER_ADMIN', () => ids.superAdmin],
  ])(
    'answers 403 to %s and leaves its profile unchanged',
    async (_role, id) => {
      const before = await requireRow(id());
      await request(server())
        .post(route)
        .set(as(id()))
        .send({ outcome: 'COMPLETED' })
        .expect(403);
      expect(await requireRow(id())).toEqual(before);
      expect(before.onboarding_completed_at).toBeNull();
    },
  );

  it('answers 404 to a client without profile and does not create one', async () => {
    await request(server())
      .post(route)
      .set(as(ids.noProfile))
      .send({ outcome: 'COMPLETED' })
      .expect(404);
    expect(await row(ids.noProfile)).toBeNull();
  });

  it('keeps accepting the historic PUT /profile/me bodies and never touches the mark', async () => {
    await request(server())
      .post(route)
      .set(as(ids.legacyPut))
      .send({ outcome: 'SKIPPED' })
      .expect(200);
    const marked = await requireRow(ids.legacyPut);
    // Body sent by the onboarding submit of released apps.
    const onboarding = await request(server())
      .put('/api/v1/profile/me')
      .set(as(ids.legacyPut))
      .send({
        first_name: 'Ana',
        last_name: 'Legacy',
        birth_date: '1990-05-17T00:00:00.000',
        height: 168,
        current_weight: 64.5,
        level: 'INTERMEDIO',
        main_goal: 'Perder grasa',
        target_calories: 1900,
        muscle_mass_goal: 28,
      })
      .expect(200);
    expect(data(onboarding).onboarding_outcome).toBe('SKIPPED');
    expect(Date.parse(String(data(onboarding).onboarding_completed_at))).toBe(
      rowInstant(marked.onboarding_completed_at),
    );
    // Body sent by the profile edit screen of released apps.
    await request(server())
      .put('/api/v1/profile/me')
      .set(as(ids.legacyPut))
      .send({
        first_name: 'Ana María',
        last_name: 'Legacy',
        main_goal: 'Salud',
      })
      .expect(200);
    const after = await requireRow(ids.legacyPut);
    expect(after.first_name).toBe('Ana María');
    expect(after.onboarding_completed_at).toEqual(
      marked.onboarding_completed_at,
    );
    expect(after.onboarding_outcome).toBe('SKIPPED');
  });

  it.each([
    ['onboarding_completed_at', '2020-01-01T00:00:00.000Z'],
    ['onboarding_outcome', 'COMPLETED'],
  ])(
    'rejects %s in PUT /profile/me and PATCH /admin/clients/:id/profile',
    async (key, value) => {
      const own = await requireRow(ids.absent);
      await request(server())
        .put('/api/v1/profile/me')
        .set(as(ids.absent))
        .send({ first_name: 'Changed', [key]: value })
        .expect(400);
      expect(await requireRow(ids.absent)).toEqual(own);
      const managed = await requireRow(ids.adminPatched);
      await request(server())
        .patch(`/api/v1/admin/clients/${ids.adminPatched}/profile`)
        .set(as(ids.superAdmin))
        .send({ first_name: 'Changed', [key]: value })
        .expect(400);
      expect(await requireRow(ids.adminPatched)).toEqual(managed);
    },
  );

  it('admin profile edits leave the onboarding columns as they were', async () => {
    await request(server())
      .post(route)
      .set(as(ids.adminPatched))
      .send({ outcome: 'COMPLETED' })
      .expect(200);
    const marked = await requireRow(ids.adminPatched);
    await request(server())
      .patch(`/api/v1/admin/clients/${ids.adminPatched}/profile`)
      .set(as(ids.superAdmin))
      .send({ first_name: 'Edited', current_weight: 70 })
      .expect(200);
    const after = await requireRow(ids.adminPatched);
    expect(after.first_name).toBe('Edited');
    expect(after.onboarding_completed_at).toEqual(
      marked.onboarding_completed_at,
    );
    expect(after.onboarding_outcome).toBe('COMPLETED');
  });
});
