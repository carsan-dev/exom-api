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
