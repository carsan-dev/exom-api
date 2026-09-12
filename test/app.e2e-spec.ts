import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SchedulerRegistry } from '@nestjs/schedule';
import request from 'supertest';
import type { Server } from 'node:http';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import { PrismaService } from '../src/prisma/prisma.service';
import { assertTestDatabase, databaseUrl } from '../scripts/test-database.cjs';

describe('Application HTTP contracts and lifecycle (isolated PostgreSQL)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let scheduler: SchedulerRegistry;
  const server = () => app.getHttpServer<Server>();

  beforeAll(async () => {
    const probe = new Pool({ connectionString: databaseUrl() });
    try {
      await assertTestDatabase(probe);
    } finally {
      await probe.end();
    }
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    scheduler = app.get(SchedulerRegistry);
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    if (app) {
      const jobs = scheduler?.getCronJobs();
      try {
        expect(jobs?.size).toBeGreaterThan(0);
      } finally {
        await app.close();
      }
      expect(jobs?.size).toBe(0);
      expect(prisma.postgresqlPool.ended).toBe(true);
    }
  });

  it('serves liveness and preserves the legacy probe', async () => {
    await request(server())
      .get('/api/v1/health/live')
      .expect(200)
      .expect(({ body }: { body: { data: { status: string } } }) =>
        expect(body.data.status).toBe('alive'),
      );
    await request(server()).get('/api/v1/public/healthchk').expect(200);
  });

  it('readiness verifies a real database connection', async () => {
    await request(server())
      .get('/api/v1/health/ready')
      .expect(200)
      .expect(({ body }: { body: { data: { status: string } } }) =>
        expect(body.data.status).toBe('ready'),
      );
  });

  it('reports database failure as unready, keeps liveness, then recovers', async () => {
    const query = jest
      .spyOn(prisma.postgresqlPool, 'query')
      .mockRejectedValueOnce(new Error('synthetic database outage'));
    try {
      const result = await request(server())
        .get('/api/v1/health/ready')
        .expect(503);
      expect(result.text).not.toContain('synthetic database outage');
      await request(server()).get('/api/v1/health/live').expect(200);
    } finally {
      query.mockRestore();
    }
    await request(server()).get('/api/v1/health/ready').expect(200);
  });

  it('does not resurrect the removed root controller', async () => {
    await request(server()).get('/').expect(404);
  });

  it.each([
    '/api/v1/auth/me',
    '/api/v1/trainings/day',
    '/api/v1/admin/clients',
  ])('requires authentication for %s', async (route) => {
    await request(server()).get(route).expect(401);
  });

  it('rejects anonymous upload session writes', async () => {
    await request(server())
      .post('/api/v1/uploads/sessions')
      .send({})
      .expect(401);
  });

  it('enforces strict release DTO validation', async () => {
    await request(server())
      .patch('/api/v1/public/mobile-config/release')
      .send({
        platform: 'desktop',
        version: '1.0.0',
        build: 0,
        policy: 'none',
        unexpected: true,
      })
      .expect(400);
  });

  it('rejects publishing metadata without its release token', async () => {
    await request(server())
      .patch('/api/v1/public/mobile-config/release')
      .send({ platform: 'android', version: '1.0.0', build: 1, policy: 'none' })
      .expect(401);
  });
});
