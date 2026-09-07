import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import type { Request, Response, NextFunction } from 'express';
import type { Server } from 'node:http';
import request from 'supertest';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ClientDeletionController } from './client-deletion.controller';
import { ClientDeletionService } from './client-deletion.service';

describe('F004 deletion HTTP authorization and confirmation', () => {
  let app: INestApplication<Server>;
  const id = 'e234ab50-e58b-4310-ace9-304655bca88b';
  const deletion = { request: jest.fn(), list: jest.fn(), get: jest.fn() };
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [ClientDeletionController],
      providers: [{ provide: ClientDeletionService, useValue: deletion }],
    }).compile();
    app = module.createNestApplication();
    // Authentication is simulated here; the production RolesGuard and DTO
    // validation execute over HTTP. Target ownership is tested with real PG.
    app.use(
      (
        req: Request & { user?: unknown },
        _res: Response,
        next: NextFunction,
      ) => {
        if (req.headers['x-test-role'])
          req.user = { id: 'actor', role: req.headers['x-test-role'] };
        next();
      },
    );
    app.useGlobalGuards(new RolesGuard(new Reflector()));
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
  });
  beforeEach(() => {
    jest.clearAllMocks();
    deletion.request.mockResolvedValue({ id, status: 'PENDING' });
  });
  afterAll(async () => {
    await app.close();
  });

  it.each(['ADMIN', 'CLIENT', ''])(
    'denies role %s for deletion and status reads',
    async (role) => {
      await request(app.getHttpServer())
        .delete(`/admin/clients/${id}`)
        .set('x-test-role', role)
        .send({ confirmation: 'ELIMINAR' })
        .expect(403);
      await request(app.getHttpServer())
        .get('/admin/client-deletions')
        .set('x-test-role', role)
        .expect(403);
      expect(deletion.request).not.toHaveBeenCalled();
      expect(deletion.list).not.toHaveBeenCalled();
    },
  );
  it.each([
    {},
    { confirmation: true },
    { confirmation: 'eliminar' },
    { confirmation: 'ELIMINAR', extra: 'ignored' },
  ])('rejects invalid confirmation %j', async (body) => {
    await request(app.getHttpServer())
      .delete(`/admin/clients/${id}`)
      .set('x-test-role', 'SUPER_ADMIN')
      .send(body)
      .expect(400);
    expect(deletion.request).not.toHaveBeenCalled();
  });
  it('returns accepted, never completed, while cleanup is pending', async () => {
    const result = await request(app.getHttpServer())
      .delete(`/admin/clients/${id}`)
      .set('x-test-role', 'SUPER_ADMIN')
      .send({ confirmation: 'ELIMINAR' })
      .expect(202);
    expect(result.body).toEqual({ id, status: 'PENDING' });
    expect(deletion.request).toHaveBeenCalledWith(id, 'actor');
  });
});
