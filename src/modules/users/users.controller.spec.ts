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
      Role.ADMIN,
      expect.objectContaining({
        role: Role.ADMIN,
        page: 2,
        limit: 10,
      }),
    );
  });
});
