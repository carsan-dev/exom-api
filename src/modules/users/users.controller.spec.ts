import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { Role } from '@prisma/client';
import request from 'supertest';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

describe('UsersController', () => {
  let app: INestApplication;
  const usersService = {
    updateFcmToken: jest.fn(),
    findAll: jest.fn(),
    createClient: jest.fn(),
    unlockUser: jest.fn(),
    updateRole: jest.fn(),
    getMyClients: jest.fn(),
    getClientProfile: jest.fn(),
    replyToTrainingNote: jest.fn(),
  };

  beforeEach(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        {
          provide: UsersService,
          useValue: usersService,
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use((request: { user?: unknown }, _response: unknown, next: () => void) => {
      request.user = {
        id: 'admin-1',
        email: 'admin@exom.dev',
        role: Role.ADMIN,
        firebase_uid: 'firebase-admin-1',
      };
      next();
    });
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

  it('rejects invalid role filters with 400', async () => {
    await request(app.getHttpServer())
      .get('/admin/users')
      .query({ role: 'INVALID' })
      .expect(400);

    expect(usersService.findAll).not.toHaveBeenCalled();
  });

  it('passes validated query params to the service', async () => {
    usersService.findAll.mockResolvedValue({
      data: [],
      total: 0,
      page: 2,
      limit: 10,
      totalPages: 0,
    });

    await request(app.getHttpServer())
      .get('/admin/users')
      .query({ role: Role.ADMIN, page: '2', limit: '10' })
      .expect(200);

    expect(usersService.findAll).toHaveBeenCalledWith(
      expect.objectContaining({
        role: Role.ADMIN,
        page: 2,
        limit: 10,
      }),
    );
  });

  it('passes a validated training note reply to the service', async () => {
    usersService.replyToTrainingNote.mockResolvedValue({ id: 'progress-1' });

    await request(app.getHttpServer())
      .put('/admin/clients/client-1/progress/reply')
      .send({ date: '2026-06-29', reply: '  Reduce el peso  ' })
      .expect(200);

    expect(usersService.replyToTrainingNote).toHaveBeenCalledWith(
      'admin-1',
      Role.ADMIN,
      'client-1',
      '2026-06-29',
      'Reduce el peso',
    );
  });

  it('rejects training note replies longer than 1000 characters', async () => {
    await request(app.getHttpServer())
      .put('/admin/clients/client-1/progress/reply')
      .send({ date: '2026-06-29', reply: 'x'.repeat(1001) })
      .expect(400);

    expect(usersService.replyToTrainingNote).not.toHaveBeenCalled();
  });
});
