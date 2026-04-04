import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test, type TestingModule } from '@nestjs/testing';
import { Role } from '@prisma/client';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AchievementsController } from './achievements.controller';
import { AchievementsService } from './achievements.service';

describe('AchievementsController', () => {
  let app: INestApplication;
  const achievementsService = {
    findAll: jest.fn(),
    findMyAchievements: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
    grantToUser: jest.fn(),
    revokeFromUser: jest.fn(),
    recomputeAchievements: jest.fn(),
  };

  beforeEach(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [AchievementsController],
      providers: [
        {
          provide: AchievementsService,
          useValue: achievementsService,
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use((req: Request, _res: Response, next: NextFunction) => {
      const roleHeader = req.header('x-test-role');

      if (roleHeader) {
        req.user = {
          id: 'user-1',
          email: 'user-1@exom.dev',
          role: roleHeader,
          firebase_uid: `firebase-${roleHeader.toLowerCase()}`,
        };
      }

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

  it('allows clients to fetch their unlocked achievements', async () => {
    achievementsService.findMyAchievements.mockResolvedValue([{ id: 'ua-1' }]);

    await request(app.getHttpServer())
      .get('/achievements/my')
      .set('x-test-role', Role.CLIENT)
      .expect(200);

    expect(achievementsService.findMyAchievements).toHaveBeenCalledWith('user-1');
  });

  it.each([Role.ADMIN, Role.SUPER_ADMIN])(
    'rejects %s users from fetching their unlocked achievements',
    async (role) => {
      await request(app.getHttpServer())
        .get('/achievements/my')
        .set('x-test-role', role)
        .expect(403);

      expect(achievementsService.findMyAchievements).not.toHaveBeenCalled();
    },
  );
});
