import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { RecapStatus } from '@prisma/client';
import type { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { RecapsController } from './recaps.controller';
import { RecapsService } from './recaps.service';

describe('RecapsController', () => {
  let app: INestApplication;
  const recapsService = {
    create: jest.fn(),
    findMyRecaps: jest.fn(),
    findForAdmin: jest.fn(),
    getStats: jest.fn(),
    getAdminRecapById: jest.fn(),
    update: jest.fn(),
    submit: jest.fn(),
    review: jest.fn(),
    archive: jest.fn(),
  };

  beforeEach(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [RecapsController],
      providers: [
        {
          provide: RecapsService,
          useValue: recapsService,
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.user = {
        id: 'admin-1',
        email: 'admin-1@exom.dev',
        role: 'ADMIN',
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

  it('rejects invalid recap status filters with 400', async () => {
    await request(app.getHttpServer())
      .get('/recaps')
      .query({ status: 'INVALID' })
      .expect(400);

    expect(recapsService.findForAdmin).not.toHaveBeenCalled();
  });

  it('rejects draft recap status filters with 400', async () => {
    await request(app.getHttpServer())
      .get('/recaps')
      .query({ status: RecapStatus.DRAFT })
      .expect(400);

    expect(recapsService.findForAdmin).not.toHaveBeenCalled();
  });

  it('passes validated admin recap filters to the service', async () => {
    recapsService.findForAdmin.mockResolvedValue({
      data: [],
      total: 0,
      page: 2,
      limit: 10,
      totalPages: 0,
    });

    await request(app.getHttpServer())
      .get('/recaps')
      .query({
        client_id: '550e8400-e29b-41d4-a716-446655440000',
        status: RecapStatus.REVIEWED,
        archived: 'true',
        page: '2',
        limit: '10',
      })
      .expect(200);

    expect(recapsService.findForAdmin).toHaveBeenCalledWith(
      'admin-1',
      'ADMIN',
      expect.objectContaining({
        client_id: '550e8400-e29b-41d4-a716-446655440000',
        status: RecapStatus.REVIEWED,
        archived: true,
        page: 2,
        limit: 10,
      }),
    );
  });

  it('rejects the legacy notes field in review payloads', async () => {
    await request(app.getHttpServer())
      .put('/recaps/recap-1/review')
      .send({ notes: 'legacy comment' })
      .expect(400);

    expect(recapsService.review).not.toHaveBeenCalled();
  });
});
