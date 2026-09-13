import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import type { ExecutionContext } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { OpenAPIObject, SchemaObject } from '@nestjs/swagger';
import Ajv from 'ajv';
import request from 'supertest';
import type { Request } from 'express';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import { createOpenApiDocument } from '../src/openapi';
import { FirebaseAuthGuard } from '../src/common/guards/firebase-auth.guard';
import { PrismaService } from '../src/prisma/prisma.service';
import { ApprovalRequestsService } from '../src/modules/approval-requests/approval-requests.service';
import { databaseUrl, verifyDatabase } from '../scripts/test-database.cjs';

describe('P10 OpenAPI against real HTTP, DTOs and PostgreSQL', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let document: OpenAPIObject;
  const owner = randomUUID();
  const exercise = randomUUID();
  const trainings: string[] = [];
  const config = {
    version: 1,
    unit: 'MINUTES',
    segments: [
      { action: 'Corre', seconds: 120, unit: 'MINUTES' },
      { action: 'Camina', seconds: 60, unit: 'MINUTES' },
    ],
  };
  const server = () => app.getHttpServer();
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
    // This instance spy keeps the original implementation before the prototype
    // seam is installed; anonymous requests still execute the real guard.
    jest.spyOn(originalGuard, 'canActivate');
    // Only Firebase identity verification is substituted; HTTP, role guards,
    // validation, interceptors, services, SQL and serialization are real.
    jest
      .spyOn(FirebaseAuthGuard.prototype, 'canActivate')
      .mockImplementation(function (
        this: FirebaseAuthGuard,
        context: ExecutionContext,
      ) {
        const req = context
          .switchToHttp()
          .getRequest<Request & { user?: unknown }>();
        if (req.headers['x-contract-owner'] === owner) {
          req.user = {
            id: owner,
            email: `${owner}@example.test`,
            firebase_uid: owner,
            role: req.headers['x-contract-role'] ?? 'SUPER_ADMIN',
          };
          return Promise.resolve(true);
        }
        return originalGuard.canActivate(context);
      });
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    document = createOpenApiDocument(app);
    await prisma.user.create({
      data: {
        id: owner,
        firebase_uid: owner,
        email: `${owner}@example.test`,
        role: 'SUPER_ADMIN',
      },
    });
    await prisma.exercise.create({
      data: {
        id: exercise,
        name: 'Contract running',
        muscle_groups: [],
        equipment: [],
      },
    });
  });
  function responseData(response: { body: unknown }): Record<string, unknown> {
    const body = response.body;
    if (
      !body ||
      typeof body !== 'object' ||
      !('data' in body) ||
      !body.data ||
      typeof body.data !== 'object' ||
      Array.isArray(body.data)
    )
      throw Error('Expected response data object');
    return Object.fromEntries(Object.entries(body.data));
  }
  function responseId(response: { body: unknown }): string {
    const id = responseData(response).id;
    if (typeof id !== 'string') throw Error('Expected response data.id string');
    return id;
  }
  afterAll(async () => {
    try {
      if (prisma) {
        await prisma.user.deleteMany({ where: { id: owner } });
        await prisma.training.deleteMany({ where: { id: { in: trainings } } });
        await prisma.exercise.deleteMany({ where: { id: exercise } });
      }
    } finally {
      jest.restoreAllMocks();
      if (app) await app.close();
    }
  });
  function validate(schema: object, value: unknown) {
    const ajv = new Ajv({
      allErrors: true,
      nullable: true,
      unknownFormats: 'ignore',
    });
    const check = ajv.compile({ ...schema, components: document.components });
    const valid = check(value);
    expect({ valid, errors: check.errors }).toEqual({
      valid: true,
      errors: null,
    });
  }
  function responseSchema(
    route: string,
    method: 'get' | 'post' | 'put' | 'delete',
    status: number,
  ) {
    const operation = document.paths[route][method]!;
    const response =
      operation.responses[String(status)] ?? operation.responses.default;
    if (!response || '$ref' in response) throw Error('Missing response schema');
    return response.content?.['application/json'].schema ?? {};
  }
  function payload() {
    return {
      name: 'Contract intervals',
      type: 'CARDIO',
      level: 'PRINCIPIANTE',
      items: [
        {
          kind: 'EXERCISE',
          exercise_id: exercise,
          sets: 1,
          order: 0,
          reps_or_duration: '1440s',
          measure_type: 'SECONDS',
          target_value: 1440,
          timed_config: config,
          rest_seconds: 15,
        },
      ],
    };
  }
  it('documents every registered operation, including response envelopes, statuses and DTO fields', () => {
    const operations = Object.values(document.paths).flatMap((p) =>
      ['get', 'post', 'put', 'patch', 'delete'].flatMap((method) => {
        const operation = p[method as 'get'];
        return operation ? [operation] : [];
      }),
    );
    // The old AppController source is not registered; its root route stays absent.
    expect(operations.length).toBeGreaterThanOrEqual(202);
    for (const operation of operations) {
      expect(operation.responses.default).toBeDefined();
      for (const [code, response] of Object.entries(operation.responses)) {
        if (
          +code >= 200 &&
          +code < 300 &&
          +code !== 204 &&
          response &&
          !('$ref' in response)
        )
          expect(response.content?.['application/json'].schema).toBeDefined();
      }
    }
    const schema = document.components!.schemas!
      .UpdateRirCycleDto as SchemaObject;
    expect(schema.required).toEqual(
      expect.arrayContaining([
        'operation_id',
        'expected_revision',
        'effective_from',
        'config',
      ]),
    );
    expect(
      document.paths['/api/v1/trainings/day'].get!.parameters,
    ).toContainEqual(
      expect.objectContaining({ name: 'date', required: false }),
    );
  });
  it('serializes liveness through the documented envelope', async () => {
    const res = await request(server()).get('/api/v1/health/live').expect(200);
    validate(responseSchema('/api/v1/health/live', 'get', 200), res.body);
    expect(document.paths['/api/v1/health/live'].get!.security).toEqual([]);
  });
  it('documents multipart session uploads and validates DTOs declared in controllers', async () => {
    const operation =
      document.paths['/api/v1/uploads/sessions/{id}/file'].post!;
    expect(operation.requestBody).toMatchObject({
      content: {
        'multipart/form-data': {
          schema: {
            required: ['file'],
            properties: { file: { type: 'string', format: 'binary' } },
          },
        },
      },
    });
    const schema = document.components!.schemas!.CreateUploadSessionDto;
    const invalid = {
      purpose: 'FEEDBACK_VIDEO',
      content_type: 'video/mp4',
      bytes: 0,
    };
    const ajv = new Ajv({ nullable: true });
    const check = ajv.compile({ ...schema, components: document.components });
    expect(check(invalid)).toBe(false);
    const response = await request(server())
      .post('/api/v1/uploads/sessions')
      .set('x-contract-owner', owner)
      .send(invalid)
      .expect(400);
    validate(
      responseSchema('/api/v1/uploads/sessions', 'post', 400),
      response.body,
    );
    await request(server())
      .post(`/api/v1/uploads/sessions/${randomUUID()}/file`)
      .set('x-contract-owner', owner)
      .field('unrelated', 'value')
      .expect(400);
  });
  it('describes nullable primitive DTO fields as the values accepted by HTTP', async () => {
    const input = {
      ...payload(),
      warmup_description: 'Calienta',
      cooldown_description: 'Camina',
      accentColor: '#AABBCC',
    };
    const result = await request(server())
      .post('/api/v1/trainings')
      .set('x-contract-owner', owner)
      .send(input)
      .expect(201);
    trainings.push(responseId(result));
    validate({ $ref: '#/components/schemas/CreateTrainingDto' }, input);
    validate(responseSchema('/api/v1/trainings', 'post', 201), result.body);
    const invalid = {
      ...input,
      items: input.items.map((item) => ({ ...item, exercise_id: '' })),
    };
    const check = new Ajv({ nullable: true }).compile({
      $ref: '#/components/schemas/CreateTrainingDto',
      components: document.components,
    });
    expect(check(invalid)).toBe(false);
    await request(server())
      .post('/api/v1/trainings')
      .set('x-contract-owner', owner)
      .send(invalid)
      .expect(400);
  });
  it('reproduces the old naked DTO mismatch and rejects missing training types', async () => {
    const res = await request(server())
      .get('/api/v1/trainings/tags')
      .set('x-contract-owner', owner)
      .expect(200);
    const ajv = new Ajv({ nullable: true });
    // This is the exact DTO previously advertised as the entire HTTP body.
    const old = ajv.compile(
      document.components!.schemas!.TrainingTagsResponseDto,
    );
    expect(old(res.body)).toBe(false);
    validate(responseSchema('/api/v1/trainings/tags', 'get', 200), res.body);
    const withoutType = { ...payload(), type: undefined };
    const check = ajv.compile({
      $ref: '#/components/schemas/CreateTrainingDto',
      components: document.components,
    });
    expect(check(withoutType)).toBe(false);
    await request(server())
      .post('/api/v1/trainings')
      .set('x-contract-owner', owner)
      .send(withoutType)
      .expect(400);
  });
  it('exposes real 401 and 400 errors without a success wrapper', async () => {
    const denied = await request(server())
      .get('/api/v1/trainings/day')
      .expect(401);
    validate(responseSchema('/api/v1/trainings/day', 'get', 401), denied.body);
    const invalid = await request(server())
      .post('/api/v1/trainings')
      .set('x-contract-owner', owner)
      .send({ ...payload(), unexpected: true })
      .expect(400);
    validate(responseSchema('/api/v1/trainings', 'post', 400), invalid.body);
  });
  it('round trips timed create/detail/list/day through real services and schemas', async () => {
    const input = payload();
    input.items[0].timed_config = {
      ...config,
      segments: config.segments.map((segment) => ({
        ...segment,
        action: `${' '.repeat(81)}${segment.action} `,
      })),
    };
    validate({ $ref: '#/components/schemas/CreateTrainingDto' }, input);
    const created = await request(server())
      .post('/api/v1/trainings')
      .set('x-contract-owner', owner)
      .send(input)
      .expect(201);
    const id = responseId(created);
    trainings.push(id);
    validate(responseSchema('/api/v1/trainings', 'post', 201), created.body);
    const detail = await request(server())
      .get(`/api/v1/trainings/${id}`)
      .set('x-contract-owner', owner)
      .expect(200);
    validate(responseSchema('/api/v1/trainings/{id}', 'get', 200), detail.body);
    const explanation: unknown = expect.stringContaining('24 min');
    expect(responseData(detail)).toMatchObject({
      exercises: [
        {
          timed_config: config,
          exercise: { explanation_text: explanation },
        },
      ],
    });
    const list = await request(server())
      .get('/api/v1/trainings?page=1&limit=5')
      .set('x-contract-owner', owner)
      .expect(200);
    validate(responseSchema('/api/v1/trainings', 'get', 200), list.body);
    await prisma.planAssignment.create({
      data: { client_id: owner, date: new Date('2099-01-05'), training_id: id },
    });
    const day = await request(server())
      .get('/api/v1/trainings/day?date=2099-01-05')
      .set('x-contract-owner', owner)
      .set('x-contract-role', 'CLIENT')
      .expect(200);
    validate(responseSchema('/api/v1/trainings/day', 'get', 200), day.body);
    const legacy = {
      name: 'Legacy',
      type: 'CARDIO',
      level: 'PRINCIPIANTE',
      exercises: [
        { exercise_id: exercise, sets: 1, order: 0, reps_or_duration: '90s' },
      ],
    };
    validate({ $ref: '#/components/schemas/CreateTrainingDto' }, legacy);
    const old = await request(server())
      .post('/api/v1/trainings')
      .set('x-contract-owner', owner)
      .send(legacy)
      .expect(201);
    trainings.push(responseId(old));
    validate(responseSchema('/api/v1/trainings', 'post', 201), old.body);
  });
  it('keeps nullable temporal metadata and documents service rejections', async () => {
    const input = payload();
    const nullable = {
      ...input,
      items: input.items.map((item) => ({ ...item, timed_config: null })),
    };
    validate({ $ref: '#/components/schemas/CreateTrainingDto' }, nullable);
    const res = await request(server())
      .post('/api/v1/trainings')
      .set('x-contract-owner', owner)
      .send(nullable)
      .expect(201);
    trainings.push(responseId(res));
    const bad = {
      ...input,
      items: input.items.map((item) => ({
        ...item,
        timed_config: {
          ...config,
          segments: [{ action: 'Run', seconds: 0, unit: 'SECONDS' }],
        },
      })),
    };
    const invalid = await request(server())
      .post('/api/v1/trainings')
      .set('x-contract-owner', owner)
      .send(bad)
      .expect(400);
    validate(responseSchema('/api/v1/trainings', 'post', 400), invalid.body);
  });
  it('documents 202 approval and 204 with no response body', async () => {
    const approvals = app.get(ApprovalRequestsService);
    const requires = jest
      .spyOn(approvals, 'requiresApproval')
      .mockResolvedValue(true);
    try {
      const accepted = await request(server())
        .delete(`/api/v1/trainings/${trainings[0]}`)
        .set('x-contract-owner', owner)
        .expect(202);
      validate(
        responseSchema('/api/v1/trainings/{id}', 'delete', 202),
        accepted.body,
      );
    } finally {
      requires.mockRestore();
    }
    const removed = await request(server())
      .delete(`/api/v1/trainings/${trainings[0]}`)
      .set('x-contract-owner', owner)
      .expect(204);
    expect(removed.text).toBe('');
    expect(
      document.paths['/api/v1/trainings/{id}'].delete!.responses['204'],
    ).toEqual({ description: 'Sin contenido' });
  });
});
