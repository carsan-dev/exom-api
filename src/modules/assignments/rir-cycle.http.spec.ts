import {
  ConflictException,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { AssignmentsController } from './assignments.controller';
import { AssignmentsService } from './assignments.service';
import { RirCycleService } from './rir-cycle.service';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { TransformInterceptor } from '../../common/interceptors/transform.interceptor';

describe('RIR HTTP controller, role guard and strict payload', () => {
  let app: INestApplication<Server>;
  const update = jest.fn();
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [AssignmentsController],
      providers: [
        { provide: AssignmentsService, useValue: {} },
        {
          provide: RirCycleService,
          useValue: {
            update,
            read: () => ({ revision: 0, versions: [], dates: [] }),
          },
        },
      ],
    }).compile();
    app = module.createNestApplication();
    app.use(
      (
        req: Request & { user?: AuthenticatedUser },
        _res: Response,
        next: NextFunction,
      ) => {
        req.user = {
          id: 'fixture',
          firebase_uid: 'fixture',
          email: 'fixture@example.test',
          role: req.header('x-test-role') ?? 'ADMIN',
        };
        next();
      },
    );
    app.useGlobalGuards(new RolesGuard(new Reflector()));
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalInterceptors(new TransformInterceptor());
    await app.init();
  });
  beforeEach(() => update.mockReset().mockResolvedValue({ revision: 1 }));
  afterAll(async () => {
    await app.close();
  });
  const endpoint = '/assignments/clients/legacy-client/rir-cycle';
  const payload = () => ({
    operation_id: randomUUID(),
    expected_revision: 0,
    effective_from: '2099-01-05',
    config: { sequence: [0, 10], overrides: {} },
  });
  it('exposes the versioned envelope and passes explicit cancellation', async () => {
    const response = await request(app.getHttpServer())
      .get(endpoint + '?from=2099-01-05&to=2099-01-12')
      .expect(200);
    expect(response.body).toMatchObject({
      data: { revision: 0, versions: [], dates: [] },
    });
    await request(app.getHttpServer())
      .put(endpoint)
      .send({ ...payload(), config: null })
      .expect(200);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'ADMIN' }),
      'legacy-client',
      expect.objectContaining({ config: null }),
    );
  });
  it.each(['CLIENT', 'UNKNOWN'])(
    'rejects role %s before invoking management',
    async (role) => {
      await request(app.getHttpServer())
        .put(endpoint)
        .set('x-test-role', role)
        .send(payload())
        .expect(403);
      expect(update).not.toHaveBeenCalled();
    },
  );
  it('rejects missing operation/config, fractional revision and unknown root fields', async () => {
    for (const body of [
      { ...payload(), operation_id: undefined },
      { ...payload(), config: undefined },
      { ...payload(), expected_revision: 1.5 },
      { ...payload(), client_id: 'another' },
    ])
      await request(app.getHttpServer()).put(endpoint).send(body).expect(400);
    expect(update).not.toHaveBeenCalled();
  });
  it('propagates stale revision as HTTP 409', async () => {
    update.mockRejectedValue(new ConflictException('El mesociclo ha cambiado'));
    await request(app.getHttpServer())
      .put(endpoint)
      .send(payload())
      .expect(409);
  });
});
