import {
  INestApplication,
  ServiceUnavailableException,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import type { Request, Response, NextFunction } from 'express';
import type { Server } from 'node:http';
import request from 'supertest';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UsersController } from '../users/users.controller';
import { UsersService } from '../users/users.service';
import { AllExceptionsFilter } from '../../common/filters/http-exception.filter';

describe('P5 identity HTTP authorization and request identity', () => {
  let app: INestApplication<Server>;
  const users = {
    createClient: jest.fn(),
    createAdmin: jest.fn(),
    updateUser: jest.fn(),
    updateUserStatus: jest.fn(),
  };
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [{ provide: UsersService, useValue: users }],
    }).compile();
    app = module.createNestApplication();
    app.use(
      (
        req: Request & { user?: unknown },
        _res: Response,
        next: NextFunction,
      ) => {
        req.user = { id: 'actor', role: req.headers['x-test-role'] };
        next();
      },
    );
    app.useGlobalGuards(new RolesGuard(new Reflector()));
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        transformOptions: { enableImplicitConversion: true },
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
  });
  afterEach(() => jest.clearAllMocks());
  afterAll(async () => {
    await app.close();
  });
  it.each(['IDENTITY_RECOVERY_PENDING', 'ACCOUNT_DELETION_PENDING'])(
    'exposes only the safe recovery receipt for %s through the production filter',
    async (code) => {
      const operationId = 'e234ab50-e58b-4310-ace9-304655bca88b';
      users.updateUserStatus.mockRejectedValueOnce(
        new ServiceUnavailableException({
          code,
          operation_id: operationId,
          firebase_uid: 'must-not-leak',
          message: 'Pendiente',
        }),
      );
      const response = await request(app.getHttpServer())
        .put('/admin/users/target/status')
        .set('x-test-role', 'SUPER_ADMIN')
        .send({ is_active: false })
        .expect(503);
      expect(response.body).toMatchObject({ code, operation_id: operationId });
      expect(response.body).not.toHaveProperty('firebase_uid');
    },
  );
  it.each(['ADMIN', 'CLIENT'])(
    'denies %s access to email/status and admin creation',
    async (role) => {
      await request(app.getHttpServer())
        .put('/admin/users/target/status')
        .set('x-test-role', role)
        .send({ is_active: false })
        .expect(403);
      await request(app.getHttpServer())
        .put('/admin/users/target')
        .set('x-test-role', role)
        .send({})
        .expect(403);
      await request(app.getHttpServer())
        .post('/admin/users/admins')
        .set('x-test-role', role)
        .send({})
        .expect(403);
      expect(users.updateUserStatus).not.toHaveBeenCalled();
    },
  );
  it.each(['false', 'true', 0, null])(
    'rejects malformed status %s instead of activating the account',
    async (is_active) => {
      await request(app.getHttpServer())
        .put('/admin/users/target/status')
        .set('x-test-role', 'SUPER_ADMIN')
        .send({ is_active })
        .expect(400);
      expect(users.updateUserStatus).not.toHaveBeenCalled();
    },
  );
  it('preserves actor and idempotency key for a valid state change', async () => {
    const key = 'test-request-123456';
    await request(app.getHttpServer())
      .put('/admin/users/target/status')
      .set('x-test-role', 'SUPER_ADMIN')
      .set('Idempotency-Key', key)
      .send({ is_active: false })
      .expect(200);
    expect(users.updateUserStatus).toHaveBeenCalledWith(
      'actor',
      'target',
      { is_active: false },
      key,
    );
  });
});
