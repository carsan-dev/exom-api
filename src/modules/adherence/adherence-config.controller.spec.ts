import type { Server } from 'node:http';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import request from 'supertest';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { AdherenceConfigController } from './adherence-config.controller';
import { AdherenceConfigService } from './adherence-config.service';

describe('AdherenceConfigController', () => {
  let app: INestApplication<Server>;
  const config = { get: jest.fn(), update: jest.fn() };

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AdherenceConfigController],
      providers: [{ provide: AdherenceConfigService, useValue: config }],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use((req: { user?: unknown }, _res: unknown, next: () => void) => {
      req.user = { id: 'admin', role: Role.ADMIN };
      next();
    });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterEach(async () => {
    jest.clearAllMocks();
    await app.close();
  });

  it('requires admin roles at the route boundary', () => {
    const reflector = app.get(Reflector);
    expect(reflector.get(ROLES_KEY, AdherenceConfigController)).toEqual([
      Role.ADMIN,
      Role.SUPER_ADMIN,
    ]);
  });

  it('passes validated client identity and date to authorized service', async () => {
    config.get.mockResolvedValue({ known: false, source: 'uncaptured' });
    await request(app.getHttpServer())
      .get('/admin/clients/client-1/adherence/config?date=2020-01-01')
      .expect(200, { known: false, source: 'uncaptured' });
    expect(config.get).toHaveBeenCalledWith(
      'admin',
      Role.ADMIN,
      'client-1',
      '2020-01-01',
    );
    await request(app.getHttpServer())
      .get('/admin/clients/client-1/adherence/config?date=2020-02-30')
      .expect(400);
  });

  it('rejects invalid replacement bodies before any write', async () => {
    const path = '/admin/clients/client-1/adherence/config';
    const valid = {
      effective_date: '2099-01-01',
      expected_version: 0,
      steps_goal: null,
      calorie_lower_percent: 10,
      calorie_upper_percent: 10,
      protein_min_percent: 90,
      steps_min_percent: 100,
      low_global_percent: 80,
    };
    for (const payload of [
      { ...valid, effective_date: '2099-02-30' },
      { ...valid, low_global_percent: 101 },
      { ...valid, steps_goal: 0 },
      { ...valid, target_calories: 1800 },
    ]) {
      await request(app.getHttpServer()).put(path).send(payload).expect(400);
    }
    expect(config.update).not.toHaveBeenCalled();
    config.update.mockResolvedValue({ version: 1 });
    await request(app.getHttpServer()).put(path).send(valid).expect(200);
    expect(config.update).toHaveBeenCalledWith(
      'admin',
      Role.ADMIN,
      'client-1',
      valid,
    );
  });
});
