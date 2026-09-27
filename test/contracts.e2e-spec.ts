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
  const admin = randomUUID();
  const client = randomUUID();
  const exercise = randomUUID();
  const otherClient = randomUUID();
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
        const identity = req.headers['x-contract-owner'];
        if (
          identity === owner ||
          identity === admin ||
          identity === client ||
          identity === otherClient
        ) {
          req.user = {
            id: identity,
            email: `${identity}@example.test`,
            firebase_uid: identity,
            role:
              identity === owner
                ? 'SUPER_ADMIN'
                : identity === admin
                  ? 'ADMIN'
                  : 'CLIENT',
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
    await prisma.user.create({
      data: {
        id: admin,
        firebase_uid: admin,
        email: `${admin}@example.test`,
        role: 'ADMIN',
      },
    });
    await prisma.user.create({
      data: {
        id: client,
        firebase_uid: client,
        email: `${client}@example.test`,
        role: 'CLIENT',
      },
    });
    await prisma.user.create({
      data: {
        id: otherClient,
        firebase_uid: otherClient,
        email: `${otherClient}@example.test`,
        role: 'CLIENT',
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
        await prisma.user.deleteMany({
          where: { id: { in: [owner, admin, client, otherClient] } },
        });
        await prisma.training.deleteMany({ where: { id: { in: trainings } } });
        await prisma.exercise.deleteMany({ where: { id: exercise } });
        expect(
          await prisma.dayProgress.count({
            where: { client_id: { in: [client, otherClient] } },
          }),
        ).toBe(0);
        expect(
          await prisma.progressOperation.count({
            where: { owner_id: { in: [client, otherClient] } },
          }),
        ).toBe(0);
        expect(
          await prisma.planAssignment.count({
            where: { client_id: { in: [client, otherClient] } },
          }),
        ).toBe(0);
        expect(
          await prisma.adminClientAssignment.count({
            where: { admin_id: admin, client_id: client },
          }),
        ).toBe(0);
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
    const detailParameters =
      document.paths['/api/v1/progress/training-sessions/{date}/{sessionId}']
        .get!.parameters;
    for (const name of ['date', 'sessionId']) {
      expect(detailParameters).toContainEqual(
        expect.objectContaining({ name, in: 'path', required: true }),
      );
    }
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
      data: {
        client_id: client,
        date: new Date('2099-01-05'),
        training_id: id,
      },
    });
    const day = await request(server())
      .get('/api/v1/trainings/day?date=2099-01-05')
      .set('x-contract-owner', client)
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
  describe('real progress completion over HTTP and PostgreSQL', () => {
    let trainingId: string;
    let trainingExerciseId: string;
    const legacyDate = '2099-02-13';
    const appV2Date = '2099-02-16';
    const sessionsDate = '2099-02-14';
    const rejectedDate = '2099-02-15';

    beforeAll(async () => {
      const created = await request(server())
        .post('/api/v1/trainings')
        .set('x-contract-owner', owner)
        .send(payload())
        .expect(201);
      trainingId = responseId(created);
      trainings.push(trainingId);
      const occurrence = await prisma.trainingExercise.findFirstOrThrow({
        where: { training_id: trainingId, exercise_id: exercise },
        select: { id: true },
      });
      trainingExerciseId = occurrence.id;
      for (const date of [legacyDate, appV2Date, sessionsDate, rejectedDate]) {
        await prisma.planAssignment.create({
          data: {
            client_id: client,
            date: new Date(date),
            training_id: trainingId,
          },
        });
      }
    });

    it('accepts the old App completion without RPE, session ID or operation headers', async () => {
      const completed = await request(server())
        .post('/api/v1/progress/trainings/complete')
        .set('x-contract-owner', client)
        .send({
          date: legacyDate,
          training_id: trainingId,
          notes: 'Daily legacy note',
        })
        .expect(201);
      expect(responseData(completed)).toMatchObject({
        training_completed: true,
        notes: 'Daily legacy note',
        trainings_completed: [trainingId],
      });
      const stored = await prisma.dayProgress.findUniqueOrThrow({
        where: {
          client_id_date: { client_id: client, date: new Date(legacyDate) },
        },
      });
      expect(stored.training_sessions).toEqual([]);
      expect(stored.notes).toBe('Daily legacy note');
      const read = await request(server())
        .get(`/api/v1/progress?date=${legacyDate}`)
        .set('x-contract-owner', client)
        .expect(200);
      expect(responseData(read)).toMatchObject({
        training_completed: true,
        notes: 'Daily legacy note',
        trainings_completed: [trainingId],
        training_sessions: [],
      });
    });

    it('accepts the App v2 legacy completion with operation headers but no session fields', async () => {
      const completed = await request(server())
        .post('/api/v1/progress/trainings/complete')
        .set('x-contract-owner', client)
        .set('x-exom-operation-id', randomUUID())
        .set('x-exom-revision', '0')
        .send({
          date: appV2Date,
          training_id: trainingId,
          notes: 'App v2 note',
        })
        .expect(201);
      expect(responseData(completed)).toMatchObject({
        training_completed: true,
        notes: 'App v2 note',
        training_sessions: [],
      });
    });

    it('retains two independent same-training/day executions and replays an exact lost response', async () => {
      const sessions = [randomUUID(), randomUUID()];
      let revision = 0;
      for (const [index, sessionId] of sessions.entries()) {
        const setPayload = {
          date: sessionsDate,
          exercise_id: exercise,
          training_exercise_id: trainingExerciseId,
          training_session_id: sessionId,
          sets: [{ set_number: 1, seconds: 30 + index * 15, rir: index }],
        };
        const setResult = await request(server())
          .post('/api/v1/progress/exercises/complete')
          .set('x-contract-owner', client)
          .set('x-exom-operation-id', randomUUID())
          .set('x-exom-revision', String(revision))
          .send(setPayload)
          .expect(201);
        revision = responseData(setResult).operation_revision as number;
        const completion = {
          date: sessionsDate,
          training_id: trainingId,
          training_session_id: sessionId,
          rpe: 6 + index,
          session_note: `Execution ${index + 1}`,
        };
        const operationId = randomUUID();
        const sendCompletion = () =>
          request(server())
            .post('/api/v1/progress/trainings/complete')
            .set('x-contract-owner', client)
            .set('x-exom-operation-id', operationId)
            .set('x-exom-revision', String(revision))
            .send(completion)
            .expect(201);
        const first = await sendCompletion();
        const persistedRevision = responseData(first).operation_revision;
        // Simulate a response lost after commit: resend identical ID/revision/body.
        const replay = await sendCompletion();
        expect(responseData(replay)).toEqual(responseData(first));
        expect(persistedRevision).toBe(responseData(first).sync_revision);
        revision = persistedRevision as number;
        expect(
          await prisma.progressOperation.count({
            where: { owner_id: client, id: operationId },
          }),
        ).toBe(1);
      }
      const stored = await prisma.dayProgress.findUniqueOrThrow({
        where: {
          client_id_date: { client_id: client, date: new Date(sessionsDate) },
        },
      });
      expect(stored.sync_revision).toBe(revision);
      expect(stored.notes).toBeNull();
      expect(stored.training_sessions).toEqual([
        {
          training_session_id: sessions[0],
          training_id: trainingId,
          rpe: 6,
          note: 'Execution 1',
        },
        {
          training_session_id: sessions[1],
          training_id: trainingId,
          rpe: 7,
          note: 'Execution 2',
        },
      ]);
      const read = await request(server())
        .get(`/api/v1/progress?date=${sessionsDate}`)
        .set('x-contract-owner', client)
        .expect(200);
      expect(responseData(read)).toMatchObject({
        training_completed: true,
        notes: null,
        training_sessions: stored.training_sessions,
        exercises_completed: stored.exercises_completed,
        sync_revision: revision,
      });
      expect(stored.exercises_completed).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            training_session_id: sessions[0],
            sets: [{ set_number: 1, seconds: 30, rir: 0 }],
          }),
          expect.objectContaining({
            training_session_id: sessions[1],
            sets: [{ set_number: 1, seconds: 45, rir: 1 }],
          }),
        ]),
      );
    });

    it('rejects anonymous, non-client and cross-assignment completion without creating progress', async () => {
      const completion = { date: rejectedDate, training_id: trainingId };
      await request(server())
        .post('/api/v1/progress/trainings/complete')
        .send(completion)
        .expect(401);
      await request(server())
        .post('/api/v1/progress/trainings/complete')
        .set('x-contract-owner', owner)
        .send(completion)
        .expect(403);
      await request(server())
        .post('/api/v1/progress/trainings/complete')
        .set('x-contract-owner', otherClient)
        .send(completion)
        .expect(403);
      expect(
        await prisma.dayProgress.count({
          where: {
            date: new Date(rejectedDate),
            client_id: { in: [client, otherClient] },
          },
        }),
      ).toBe(0);
    });

    describe('owner training read routes', () => {
      const range = 'from=2099-02-13&to=2099-02-16';
      let sessions: string[];

      beforeAll(async () => {
        // These tests intentionally follow the completion tests above in the
        // full e2e run; a test-name filter must not skip their persisted fixture.
        const day = await prisma.dayProgress.findUniqueOrThrow({
          where: {
            client_id_date: { client_id: client, date: new Date(sessionsDate) },
          },
        });
        expect(day.training_sessions).toEqual([
          expect.objectContaining({ training_id: trainingId, rpe: 6 }),
          expect.objectContaining({ training_id: trainingId, rpe: 7 }),
        ]);
        if (!Array.isArray(day.training_sessions))
          throw Error('Expected persisted training sessions');
        sessions = day.training_sessions.map((entry) => {
          if (
            !entry ||
            typeof entry !== 'object' ||
            Array.isArray(entry) ||
            !('training_session_id' in entry) ||
            typeof entry.training_session_id !== 'string'
          )
            throw Error('Expected persisted session identity');
          return entry.training_session_id;
        });
      });

      it('reports four indicators and the timed exercise table across both legacy days and two executions', async () => {
        const result = await request(server())
          .get(`/api/v1/progress/training-overview?${range}`)
          .set('x-contract-owner', client)
          .expect(200);
        expect(responseData(result)).toEqual({
          indicators: {
            trainings_completed: 4,
            volume: null,
            mean_rir: 0.5,
            mean_rpe: 6.5,
          },
          exercises: [
            {
              exercise_id: exercise,
              exercise_name: 'Contract running',
              sets: 2,
              max_reps: null,
              max_seconds: 45,
              volume: null,
              mean_rir: 0.5,
              pr: null,
            },
          ],
        });
      });

      it('pages real timed load history without inventing reps or volume', async () => {
        const result = await request(server())
          .get(`/api/v1/progress/exercises/${exercise}/load-history?${range}`)
          .set('x-contract-owner', client)
          .expect(200);
        expect(responseData(result)).toEqual({
          page: [
            {
              date: sessionsDate,
              training_session_id: sessions[0],
              training_exercise_id: trainingExerciseId,
              set_number: 1,
              reps: null,
              seconds: 30,
              weight_kg: null,
              rir: 0,
              volume: null,
            },
            {
              date: sessionsDate,
              training_session_id: sessions[1],
              training_exercise_id: trainingExerciseId,
              set_number: 1,
              reps: null,
              seconds: 45,
              weight_kg: null,
              rir: 1,
              volume: null,
            },
          ],
          nextCursor: null,
        });
      });

      it('returns confirmed session metadata and sets without borrowing the daily legacy note', async () => {
        const result = await request(server())
          .get(
            `/api/v1/progress/training-sessions/${sessionsDate}/${sessions[0]}`,
          )
          .set('x-contract-owner', client)
          .expect(200);
        expect(responseData(result)).toEqual({
          training_id: trainingId,
          training_session_id: sessions[0],
          training_name: payload().name,
          rpe: 6,
          note: 'Execution 1',
          page: [
            {
              exercise_id: exercise,
              training_exercise_id: trainingExerciseId,
              exercise_name: 'Contract running',
              set_number: 1,
              reps: null,
              seconds: 30,
              weight_kg: null,
              rir: 0,
            },
          ],
          nextCursor: null,
        });
        expect(JSON.stringify(responseData(result))).not.toContain(
          'Daily legacy note',
        );
      });

      it('pages only confirmed independent sessions with immutable historical names', async () => {
        const snapshot = await prisma.trainingDaySnapshot.findUniqueOrThrow({
          where: {
            client_id_date_training_id: {
              client_id: client,
              date: new Date(sessionsDate),
              training_id: trainingId,
            },
          },
        });
        const historical = snapshot.payload;
        if (
          !historical ||
          typeof historical !== 'object' ||
          Array.isArray(historical)
        )
          throw Error('Expected captured training prescription');
        const trainingName = 'name' in historical ? historical.name : null;
        expect(trainingName).toBe(payload().name);
        const route = '/api/v1/progress/training-sessions';
        const first = await request(server())
          .get(`${route}?${range}&limit=1`)
          .set('x-contract-owner', client)
          .expect(200);
        const firstData = responseData(first);
        expect(firstData.page).toEqual([
          {
            date: sessionsDate,
            training_id: trainingId,
            training_session_id: sessions[0],
            training_name: trainingName,
            rpe: 6,
            note: 'Execution 1',
          },
        ]);
        expect(typeof firstData.nextCursor).toBe('string');
        const cursor = firstData.nextCursor as string;
        const second = await request(server())
          .get(`${route}?${range}&limit=1&cursor=${encodeURIComponent(cursor)}`)
          .set('x-contract-owner', client)
          .expect(200);
        expect(responseData(second)).toEqual({
          page: [
            {
              date: sessionsDate,
              training_id: trainingId,
              training_session_id: sessions[1],
              training_name: trainingName,
              rpe: 7,
              note: 'Execution 2',
            },
          ],
          nextCursor: null,
        });
        expect(
          [firstData.page, responseData(second).page]
            .flat()
            .map(
              (entry) =>
                (entry as { training_session_id: string }).training_session_id,
            ),
        ).toEqual(sessions);
        // A real owner cursor must not be portable across clients or date ranges.
        await request(server())
          .get(`${route}?${range}&limit=1&cursor=${encodeURIComponent(cursor)}`)
          .set('x-contract-owner', otherClient)
          .expect(400);
        await request(server())
          .get(
            `${route}?from=2099-02-14&to=2099-02-16&limit=1&cursor=${encodeURIComponent(cursor)}`,
          )
          .set('x-contract-owner', client)
          .expect(400);
        const forged = Buffer.from(
          JSON.stringify({
            ...JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')),
            c: otherClient,
          }),
        ).toString('base64url');
        await request(server())
          .get(`${route}?${range}&limit=1&cursor=${encodeURIComponent(forged)}`)
          .set('x-contract-owner', client)
          .expect(400);
      });

      it('reads session and per-set names from the immutable day snapshot, not the live catalog', async () => {
        const snapshot = await prisma.trainingDaySnapshot.findUniqueOrThrow({
          where: {
            client_id_date_training_id: {
              client_id: client,
              date: new Date(sessionsDate),
              training_id: trainingId,
            },
          },
        });
        const historical = snapshot.payload;
        if (
          !historical ||
          typeof historical !== 'object' ||
          Array.isArray(historical)
        )
          throw Error('Expected captured training prescription');
        const entries = 'exercises' in historical ? historical.exercises : null;
        if (!Array.isArray(entries)) throw Error('Expected captured exercises');
        const occurrence = entries.find(
          (entry: unknown) =>
            entry !== null &&
            typeof entry === 'object' &&
            'id' in entry &&
            entry.id === trainingExerciseId,
        );
        if (
          !occurrence ||
          typeof occurrence !== 'object' ||
          !('exercise' in occurrence)
        )
          throw Error('Expected captured occurrence');
        const capturedExercise = occurrence.exercise;
        if (
          !capturedExercise ||
          typeof capturedExercise !== 'object' ||
          !('name' in capturedExercise)
        )
          throw Error('Expected captured exercise name');
        const trainingName = 'name' in historical ? historical.name : null;
        const exerciseName = capturedExercise.name;
        expect(trainingName).toBe(payload().name);
        expect(exerciseName).toBe('Contract running');
        const currentTraining = await prisma.training.findUniqueOrThrow({
          where: { id: trainingId },
        });
        const currentExercise = await prisma.exercise.findUniqueOrThrow({
          where: { id: exercise },
        });
        try {
          await prisma.training.update({
            where: { id: trainingId },
            data: { name: 'Renamed live training' },
          });
          await prisma.exercise.update({
            where: { id: exercise },
            data: { name: 'Renamed live exercise' },
          });
          const detail = await request(server())
            .get(
              `/api/v1/progress/training-sessions/${sessionsDate}/${sessions[0]}`,
            )
            .set('x-contract-owner', client)
            .expect(200);
          expect(responseData(detail)).toMatchObject({
            training_id: trainingId,
            training_session_id: sessions[0],
            training_name: trainingName,
            rpe: 6,
            note: 'Execution 1',
            page: [
              {
                exercise_id: exercise,
                training_exercise_id: trainingExerciseId,
                exercise_name: exerciseName,
                set_number: 1,
                seconds: 30,
              },
            ],
            nextCursor: null,
          });
          expect(JSON.stringify(responseData(detail))).not.toContain(
            'Renamed live',
          );
        } finally {
          await prisma.exercise.update({
            where: { id: exercise },
            data: { name: currentExercise.name },
          });
          await prisma.training.update({
            where: { id: trainingId },
            data: { name: currentTraining.name },
          });
        }
      });

      it('rejects invalid owner requests and isolates another client empty history', async () => {
        const overview = `/api/v1/progress/training-overview?${range}`;
        await request(server()).get(overview).expect(401);
        await request(server())
          .get(overview)
          .set('x-contract-owner', owner)
          .expect(403);
        await request(server())
          .get(`${overview}&clientId=${otherClient}`)
          .set('x-contract-owner', client)
          .expect(400);
        await request(server())
          .get(
            '/api/v1/progress/training-overview?from=2099-02-16&to=2099-02-13',
          )
          .set('x-contract-owner', client)
          .expect(400);
        await request(server())
          .get(
            '/api/v1/progress/training-overview?from=2024-01-01&to=2025-01-01',
          )
          .set('x-contract-owner', client)
          .expect(400);
        await request(server())
          .get(
            '/api/v1/progress/training-overview?from=2099-02-30&to=2099-02-16',
          )
          .set('x-contract-owner', client)
          .expect(400);
        // Owner-only routes resolve the authenticated client's own history;
        // an unrelated client sees no target data rather than a 403.
        const unrelatedLoad = await request(server())
          .get(`/api/v1/progress/exercises/${exercise}/load-history?${range}`)
          .set('x-contract-owner', otherClient)
          .expect(200);
        expect(responseData(unrelatedLoad)).toEqual({
          page: [],
          nextCursor: null,
        });
        const unrelatedSession = await request(server())
          .get(
            `/api/v1/progress/training-sessions/${sessionsDate}/${sessions[0]}`,
          )
          .set('x-contract-owner', otherClient)
          .expect(200);
        expect(unrelatedSession.body).toMatchObject({
          success: true,
          data: null,
        });
      });

      it('returns null historical names when no timed snapshot was captured', async () => {
        const date = '2099-03-01';
        const created = await request(server())
          .post('/api/v1/trainings')
          .set('x-contract-owner', owner)
          .send({
            name: 'Uncaptured legacy training',
            type: 'FUERZA',
            level: 'PRINCIPIANTE',
            exercises: [
              {
                exercise_id: exercise,
                sets: 1,
                order: 0,
                reps_or_duration: '8',
              },
            ],
          })
          .expect(201);
        const legacyTrainingId = responseId(created);
        trainings.push(legacyTrainingId);
        await prisma.planAssignment.create({
          data: {
            client_id: client,
            date: new Date(date),
            training_id: legacyTrainingId,
          },
        });
        const legacySessionId = randomUUID();
        await request(server())
          .post('/api/v1/progress/trainings/complete')
          .set('x-contract-owner', client)
          .send({
            date,
            training_id: legacyTrainingId,
            training_session_id: legacySessionId,
            rpe: 5,
          })
          .expect(201);
        expect(
          await prisma.trainingDaySnapshot.findUnique({
            where: {
              client_id_date_training_id: {
                client_id: client,
                date: new Date(date),
                training_id: legacyTrainingId,
              },
            },
          }),
        ).toBeNull();
        const detail = await request(server())
          .get(`/api/v1/progress/training-sessions/${date}/${legacySessionId}`)
          .set('x-contract-owner', client)
          .expect(200);
        expect(responseData(detail)).toMatchObject({
          training_id: legacyTrainingId,
          training_session_id: legacySessionId,
          training_name: null,
          page: [],
        });
        const list = await request(server())
          .get(`/api/v1/progress/training-sessions?from=${date}&to=${date}`)
          .set('x-contract-owner', client)
          .expect(200);
        expect(responseData(list)).toMatchObject({
          page: [
            {
              date,
              training_id: legacyTrainingId,
              training_session_id: legacySessionId,
              training_name: null,
              rpe: 5,
              note: null,
            },
          ],
          nextCursor: null,
        });
      });

      describe('admin training read routes', () => {
        const routes = () => [
          {
            owner: `/api/v1/progress/training-overview?${range}`,
            target: `/api/v1/admin/clients/${client}/progress/training-overview?${range}`,
          },
          {
            owner: `/api/v1/progress/exercises/${exercise}/load-history?${range}`,
            target: `/api/v1/admin/clients/${client}/progress/exercises/${exercise}/load-history?${range}`,
          },
          {
            owner: `/api/v1/progress/training-sessions/${sessionsDate}/${sessions[0]}`,
            target: `/api/v1/admin/clients/${client}/progress/training-sessions/${sessionsDate}/${sessions[0]}`,
          },
        ];

        it('returns the same persisted overview, loads and session for SUPER_ADMIN', async () => {
          for (const route of routes()) {
            const expected = await request(server())
              .get(route.owner)
              .set('x-contract-owner', client)
              .expect(200);
            const actual = await request(server())
              .get(route.target)
              .set('x-contract-owner', owner)
              .expect(200);
            expect(responseData(actual)).toEqual(responseData(expected));
          }
        });

        it('keeps the paged ADMIN overview equivalent to the owner and checks access before cursors', async () => {
          const ownerRoute = `/api/v1/progress/training-overview?${range}`;
          const adminRoute = `/api/v1/admin/clients/${client}/progress/training-overview?${range}`;
          const legacy = responseData(
            await request(server())
              .get(ownerRoute)
              .set('x-contract-owner', client)
              .expect(200),
          );
          const ownerPage = responseData(
            await request(server())
              .get(`${ownerRoute}&limit=1`)
              .set('x-contract-owner', client)
              .expect(200),
          );
          const adminPage = responseData(
            await request(server())
              .get(`${adminRoute}&limit=1`)
              .set('x-contract-owner', owner)
              .expect(200),
          );
          expect(legacy.indicators).toEqual({
            trainings_completed: 4,
            volume: null,
            mean_rir: 0.5,
            mean_rpe: 6.5,
          });
          expect(adminPage).toEqual(ownerPage);
          expect(adminPage).toEqual({
            indicators: legacy.indicators,
            exercises: legacy.exercises,
            next_cursor: null,
          });
          expect(adminPage.exercises).toHaveLength(1);
          await request(server())
            .get(`${adminRoute}&limit=1&cursor=invalid`)
            .set('x-contract-owner', admin)
            .expect(403);
          await request(server())
            .get(`${adminRoute}&cursor=invalid`)
            .set('x-contract-owner', owner)
            .expect(400);
          await request(server())
            .get(`${adminRoute}&limit=1&cursor=invalid`)
            .set('x-contract-owner', owner)
            .expect(400);
        });

        it('denies an unassigned ADMIN on every route, then allows an active assignment with identical values', async () => {
          for (const route of routes()) {
            await request(server())
              .get(route.target)
              .set('x-contract-owner', admin)
              .expect(403);
          }
          await prisma.adminClientAssignment.create({
            data: { admin_id: admin, client_id: client, is_active: true },
          });
          for (const route of routes()) {
            const expected = await request(server())
              .get(route.owner)
              .set('x-contract-owner', client)
              .expect(200);
            const actual = await request(server())
              .get(route.target)
              .set('x-contract-owner', admin)
              .expect(200);
            expect(responseData(actual)).toEqual(responseData(expected));
          }
        });

        it('uses the current database role rather than a stale ADMIN guard identity', async () => {
          await prisma.user.update({
            where: { id: admin },
            data: { role: 'CLIENT' },
          });
          try {
            for (const route of routes()) {
              await request(server())
                .get(route.target)
                .set('x-contract-owner', admin)
                .expect(403);
            }
          } finally {
            await prisma.user.update({
              where: { id: admin },
              data: { role: 'ADMIN' },
            });
          }
        });

        it('denies all three routes after assignment revocation and forbids CLIENT targeting another ID', async () => {
          await prisma.adminClientAssignment.update({
            where: {
              admin_id_client_id: { admin_id: admin, client_id: client },
            },
            data: { is_active: false },
          });
          for (const route of routes()) {
            await request(server())
              .get(route.target)
              .set('x-contract-owner', admin)
              .expect(403);
            await request(server())
              .get(route.target)
              .set('x-contract-owner', otherClient)
              .expect(403);
          }
        });
      });
    });
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
