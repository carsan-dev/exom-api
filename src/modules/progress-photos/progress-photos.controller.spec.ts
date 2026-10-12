import type { Server } from 'node:http';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { Role } from '@prisma/client';
import request from 'supertest';
import { RolesGuard } from '../../common/guards/roles.guard';
import {
  AdminProgressPhotosController,
  ProgressPhotosController,
} from './progress-photos.controller';
import { ProgressPhotosService } from './progress-photos.service';

describe('ProgressPhotosController HTTP contracts', () => {
  let app: INestApplication<Server>;
  let role: Role = Role.CLIENT;
  const service = {
    getHistory: jest.fn(),
    getSession: jest.fn(),
    createSession: jest.fn(),
    associatePhoto: jest.fn(),
    readPhotoFile: jest.fn(),
  };

  beforeEach(async () => {
    role = Role.CLIENT;
    const module = await Test.createTestingModule({
      controllers: [ProgressPhotosController, AdminProgressPhotosController],
      providers: [{ provide: ProgressPhotosService, useValue: service }],
    }).compile();
    app = module.createNestApplication();
    app.use((req: { user?: unknown }, _res: unknown, next: () => void) => {
      req.user = {
        id: 'actor-1',
        firebase_uid: 'firebase-actor-1',
        email: 'actor@example.test',
        role,
      };
      next();
    });
    app.useGlobalGuards(new RolesGuard(new Reflector()));
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();
  });

  afterEach(async () => {
    jest.clearAllMocks();
    await app.close();
  });

  it('validates bounded history pagination and sends an authenticated client context', async () => {
    service.getHistory.mockResolvedValue({
      data: [],
      total: 0,
      page: 2,
      limit: 10,
      totalPages: 0,
    });
    await request(app.getHttpServer())
      .get('/progress-photos/sessions?page=2&limit=10')
      .expect(200);
    expect(service.getHistory).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'actor-1', role: Role.CLIENT }),
      'actor-1',
      expect.objectContaining({ page: 2, limit: 10 }),
    );
    await request(app.getHttpServer())
      .get('/progress-photos/sessions?limit=101')
      .expect(400);
    await request(app.getHttpServer())
      .get('/progress-photos/sessions?page=1001')
      .expect(400);
    expect(service.getHistory).toHaveBeenCalledTimes(1);
  });

  it('rejects non-civil dates, unstable operation IDs, and unknown association fields before service execution', async () => {
    await request(app.getHttpServer())
      .post('/progress-photos/sessions')
      .send({ session_date: '2026-02-30', operation_id: 'session-1' })
      .expect(400);
    await request(app.getHttpServer())
      .post('/progress-photos/sessions/session-1/photos')
      .send({
        upload_id: 'not-a-uuid',
        view: 'FRONT',
        operation_id: 'invalid operation id',
        unexpected: true,
      })
      .expect(400);
    expect(service.createSession).not.toHaveBeenCalled();
    expect(service.associatePhoto).not.toHaveBeenCalled();
  });

  it('limits admin-targeted routes to admins and forwards the explicit target', async () => {
    await request(app.getHttpServer())
      .get('/admin/clients/client-2/progress-photos/sessions')
      .expect(403);
    role = Role.ADMIN;
    service.getHistory.mockResolvedValue({
      data: [],
      total: 0,
      page: 1,
      limit: 20,
      totalPages: 0,
    });
    await request(app.getHttpServer())
      .get('/admin/clients/client-2/progress-photos/sessions?page=1&limit=20')
      .expect(200);
    expect(service.getHistory).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'actor-1', role: Role.ADMIN }),
      'client-2',
      expect.objectContaining({ page: 1, limit: 20 }),
    );
  });

  it.each([Role.CLIENT, Role.ADMIN, Role.SUPER_ADMIN])(
    'streams a file only through the protected photo route for %s',
    async (actorRole) => {
      role = actorRole;
      service.readPhotoFile.mockResolvedValue({
        data: Buffer.from('photo-bytes'),
        mimeType: 'image/jpeg',
      });

      await request(app.getHttpServer())
        .get('/progress-photos/photos/photo-1/file')
        .expect('Content-Type', /image\/jpeg/)
        .expect(200);
      expect(service.readPhotoFile).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'actor-1', role: actorRole }),
        'photo-1',
      );
    },
  );
});
