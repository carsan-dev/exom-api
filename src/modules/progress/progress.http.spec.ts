import {
  ConflictException,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { Server } from 'node:http';
import { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { Role } from '@prisma/client';
import { ProgressController } from './progress.controller';
import { ProgressService } from './progress.service';
import { TrainingProgressReadService } from './training-progress-read.service';
import {
  progressCommand,
  ProgressCommand,
} from '../../common/progress/progress-command';
import { AllExceptionsFilter } from '../../common/filters/http-exception.filter';
import { TransformInterceptor } from '../../common/interceptors/transform.interceptor';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

describe('P4 HTTP offline protocol (real controller/pipes/filter, isolated auth boundary)', () => {
  let app: INestApplication<Server>;
  let conflict = false;
  const seen: Array<{
    owner: string;
    dto: unknown;
    command: ProgressCommand | undefined;
  }> = [];
  const trainingSeen: typeof seen = [];
  const current = {
    sync_revision: 7,
    exercises_completed: [
      {
        exercise_id: 'existing',
        sets: [{ set_number: 1, weight_kg: 52, rir: 2 }],
      },
    ],
    meals_completed: [],
  };
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [ProgressController],
      providers: [
        { provide: TrainingProgressReadService, useValue: {} },
        {
          provide: ProgressService,
          useValue: {
            markExerciseCompleted: (owner: string, dto: unknown) => {
              seen.push({ owner, dto, command: progressCommand.getStore() });
              if (conflict)
                throw new ConflictException({
                  code: 'PROGRESS_VERSION_CONFLICT',
                  message: 'Review current progress',
                  current_revision: 7,
                  current_progress: current,
                });
              return Promise.resolve({ ...current, operation_revision: 7 });
            },
            completeTraining: (owner: string, dto: unknown) => {
              trainingSeen.push({
                owner,
                dto,
                command: progressCommand.getStore(),
              });
              return Promise.resolve({ ...current, operation_revision: 7 });
            },
          },
        },
      ],
    }).compile();
    app = module.createNestApplication();
    // Authentication is supplied at the test boundary; no Firebase or real users.
    app.use(
      (
        req: Request & { user?: AuthenticatedUser },
        _res: Response,
        next: NextFunction,
      ) => {
        req.user = {
          id: 'isolated-client',
          firebase_uid: 'isolated-firebase',
          email: 'test@example.test',
          role: req.header('x-test-role') ?? Role.CLIENT,
        };
        next();
      },
    );
    app.setGlobalPrefix('api/v1');
    app.useGlobalGuards(new RolesGuard(new Reflector()));
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
  });
  beforeEach(() => {
    conflict = false;
    seen.length = 0;
    trainingSeen.length = 0;
  });
  afterAll(async () => {
    await app?.close();
  });
  const payload = {
    date: '2026-09-06',
    exercise_id: 'e',
    training_exercise_id: 'te',
    sets: [{ set_number: 1, seconds: 30, rir: 2 }],
  };
  it('accepts session completion and preserves operation identity across retries', async () => {
    const training = {
      date: '2026-09-06',
      training_id: 'training-a',
      training_session_id: 'session-a',
      rpe: 8,
      session_note: 'Steady effort',
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await request(app.getHttpServer())
        .post('/api/v1/progress/trainings/complete')
        .set('x-exom-operation-id', 'complete:session-a')
        .set('x-exom-revision', '2')
        .send(training)
        .expect(201);
      expect(response.body).toMatchObject({
        success: true,
        data: { sync_revision: 7, operation_revision: 7 },
      });
    }
    expect(trainingSeen).toMatchObject([
      {
        owner: 'isolated-client',
        dto: training,
        command: { id: 'complete:session-a', revision: 2 },
      },
      {
        owner: 'isolated-client',
        dto: training,
        command: { id: 'complete:session-a', revision: 2 },
      },
    ]);
    expect(trainingSeen[0]?.command?.payloadHash).toMatch(/^[a-f0-9]{64}$/);
    expect(trainingSeen[1]?.command?.payloadHash).toBe(
      trainingSeen[0]?.command?.payloadHash,
    );

    await request(app.getHttpServer())
      .post('/api/v1/progress/trainings/complete')
      .set('x-exom-operation-id', 'complete:session-a')
      .set('x-exom-revision', '2')
      .send({ ...training, training_session_id: 'session-b' })
      .expect(201);
    expect(trainingSeen[2]?.command?.payloadHash).not.toBe(
      trainingSeen[0]?.command?.payloadHash,
    );
  });

  it('accepts legacy training completion without session fields or operation headers', async () => {
    const legacy = { date: '2026-09-06', training_id: 'training-a' };
    const response = await request(app.getHttpServer())
      .post('/api/v1/progress/trainings/complete')
      .send(legacy)
      .expect(201);
    expect(response.body).toMatchObject({
      success: true,
      data: { sync_revision: 7, operation_revision: 7 },
    });
    expect(trainingSeen).toEqual([
      { owner: 'isolated-client', dto: legacy, command: undefined },
    ]);
  });

  it('rejects invalid training completion payloads and operation headers before service forwarding', async () => {
    const valid = {
      date: '2026-09-06',
      training_id: 'training-a',
      training_session_id: 'session-a',
      rpe: 8,
      session_note: 'Steady effort',
    };
    for (const invalid of [
      { ...valid, rpe: 0 },
      { ...valid, rpe: 11 },
      { ...valid, rpe: 8.5 },
      { ...valid, training_session_id: '' },
      { ...valid, training_session_id: 's'.repeat(129) },
      { ...valid, session_note: 'n'.repeat(1001) },
      { ...valid, unexpected: 'unknown' },
    ]) {
      await request(app.getHttpServer())
        .post('/api/v1/progress/trainings/complete')
        .send(invalid)
        .expect(400);
    }
    await request(app.getHttpServer())
      .post('/api/v1/progress/trainings/complete')
      .set('x-exom-operation-id', 'missing-revision')
      .send(valid)
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/v1/progress/trainings/complete')
      .set('x-exom-revision', '2')
      .send(valid)
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/v1/progress/trainings/complete')
      .set('x-test-role', Role.ADMIN)
      .send(valid)
      .expect(403);
    expect(trainingSeen).toHaveLength(0);
  });

  it('keeps conflict revision and canonical historical values in the actual HTTP error', async () => {
    conflict = true;
    const response = await request(app.getHttpServer())
      .post('/api/v1/progress/exercises/complete')
      .set('x-exom-operation-id', 'stable:1')
      .set('x-exom-revision', '2')
      .send(payload)
      .expect(409);
    const body: unknown = response.body;
    expect(body).toMatchObject({
      code: 'PROGRESS_VERSION_CONFLICT',
      current_revision: 7,
      current_progress: current,
    });
  });
  it('transports stable operation metadata and the original revision in the response envelope', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/progress/exercises/complete')
      .set('x-exom-operation-id', 'stable:1')
      .set('x-exom-revision', '2')
      .send(payload)
      .expect(201);
    const body: unknown = response.body;
    expect(body).toMatchObject({
      success: true,
      data: { sync_revision: 7, operation_revision: 7 },
    });
    expect(seen).toMatchObject([
      {
        owner: 'isolated-client',
        dto: payload,
        command: { id: 'stable:1', revision: 2 },
      },
    ]);
    expect(typeof seen[0]?.command?.payloadHash).toBe('string');
  });
  it('accepts legacy payloads without headers, rejects incomplete headers and keeps role enforcement', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/progress/exercises/complete')
      .send(payload)
      .expect(201);
    expect(seen).toEqual([
      { owner: 'isolated-client', dto: payload, command: undefined },
    ]);
    await request(app.getHttpServer())
      .post('/api/v1/progress/exercises/complete')
      .set('x-exom-operation-id', 'missing-revision')
      .send(payload)
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/v1/progress/exercises/complete')
      .set('x-test-role', Role.ADMIN)
      .send(payload)
      .expect(403);
    expect(seen).toHaveLength(1);
  });
});
