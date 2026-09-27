import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Request, Response, NextFunction } from 'express';
import type { Server } from 'node:http';
import request from 'supertest';
import { PrismaClient, Prisma, Role } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { assertTestDatabase } from '../../../scripts/test-database.cjs';
import { PrismaService } from '../../prisma/prisma.service';
import { RolesGuard } from '../../common/guards/roles.guard';
import { MetricsService } from './metrics.service';
import { MetricsController } from './metrics.controller';
import { metricsOverview } from './metrics-overview';
import { UsersService } from '../users/users.service';
import { UsersController } from '../users/users.controller';
import { TrainingProgressReadService } from '../progress/training-progress-read.service';
import { RecapsService } from '../recaps/recaps.service';
import { RecapsController } from '../recaps/recaps.controller';
import { AchievementsService } from '../achievements/achievements.service';
import { ChallengesService } from '../challenges/challenges.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CalendarService } from '../calendar/calendar.service';
import { IdentityService } from '../identity/identity.service';

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
type Overview = Awaited<ReturnType<MetricsService['getOverview']>>;
suite(
  'P1 metrics PostgreSQL / HTTP authorization / historical integrity',
  () => {
    let pool: Pool;
    let db: PrismaClient;
    let app: NestExpressApplication;
    let metrics: MetricsService;
    let recaps: RecapsService;
    const prefix = `p1-${process.pid}-${Date.now()}`;
    const users: string[] = [];
    const diets: string[] = [];
    const ingredients: string[] = [];
    const identities = new Map<string, { id: string; role: Role }>();
    const series = (overview: Overview, key: string) =>
      overview.series.find((item) => item.key === key)!;
    const query = { from: '2026-01-01', to: '2026-09-16', page: 1 };
    async function user(role: Role = 'CLIENT') {
      const id = `${prefix}-${users.length}`;
      users.push(id);
      await db.user.create({
        data: { id, email: `${id}@example.test`, firebase_uid: id, role },
      });
      identities.set(id, { id, role });
      return id;
    }
    async function nutritionFixture() {
      const id = await user();
      diets.push(id);
      ingredients.push(id);
      await db.ingredient.create({
        data: {
          id,
          name: 'Fixture',
          calories_per_100g: 400,
          protein_per_100g: 20,
          carbs_per_100g: 60,
          fat_per_100g: 10,
        },
      });
      await db.diet.create({
        data: { id, name: 'Histórica', total_calories: 700 },
      });
      await db.meal.create({
        data: {
          id,
          diet_id: id,
          name: 'Principal',
          type: 'BREAKFAST',
          calories: 350,
          protein_g: 20,
          carbs_g: 40,
          fat_g: 10,
          nutritional_badges: [],
        },
      });
      await db.meal.create({
        data: {
          id: `${id}-variant`,
          diet_id: id,
          parent_meal_id: id,
          name: 'Alternativa',
          type: 'BREAKFAST',
          nutritional_badges: [],
          ingredients: {
            create: {
              ingredient_id: id,
              quantity: 2,
              unit: 'cup',
              grams_equivalent: 50,
            },
          },
        },
      });
      await db.planAssignment.create({
        data: { client_id: id, date: new Date('2026-09-01'), diet_id: id },
      });
      await db.dayProgress.create({
        data: {
          client_id: id,
          date: new Date('2026-09-01'),
          meals_completed: [`${id}-variant`],
        },
      });
      return id;
    }
    beforeAll(async () => {
      pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
      await assertTestDatabase(pool);
      db = new PrismaClient({ adapter: new PrismaPg(pool) });
      const module = await Test.createTestingModule({
        controllers: [MetricsController, UsersController, RecapsController],
        providers: [
          MetricsService,
          UsersService,
          RecapsService,
          { provide: TrainingProgressReadService, useValue: {} },
          { provide: PrismaService, useValue: db },
          ...[
            AchievementsService,
            ChallengesService,
            NotificationsService,
            CalendarService,
            IdentityService,
          ].map((provide) => ({ provide, useValue: {} })),
        ],
      }).compile();
      metrics = module.get(MetricsService);
      recaps = module.get(RecapsService);
      app = module.createNestApplication<NestExpressApplication>();
      // Only authentication is synthetic. Real role guard, DTOs, ownership queries,
      // services and PostgreSQL execute; no Firebase, FCM, cron or real accounts.
      app.use(
        (
          req: Request & { user?: { id: string; role: Role } },
          _res: Response,
          next: NextFunction,
        ) => {
          req.user = identities.get(String(req.headers['x-test-user']));
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
    afterAll(async () => {
      await db.user.deleteMany({ where: { id: { in: users } } });
      await db.diet.deleteMany({ where: { id: { in: diets } } });
      await db.ingredient.deleteMany({ where: { id: { in: ingredients } } });
      await app?.close();
      await db?.$disconnect();
      await pool?.end();
    });

    it('P1-01/02: sparse fields, unordered dates, zero, one observation and paginated history', async () => {
      const id = await user();
      await db.bodyMetric.createMany({
        data: [
          { client_id: id, date: new Date('2026-09-10'), weight_kg: 72 },
          {
            client_id: id,
            date: new Date('2026-01-02'),
            weight_kg: 75,
            sleep_hours: 0,
          },
          {
            client_id: id,
            date: new Date('2026-09-01'),
            sleep_hours: 7,
            height_cm: 180,
          },
        ],
      });
      const overview = await metrics.getOverview(id, query);
      expect(series(overview, 'weight_kg')).toMatchObject({
        first: { value: 75, date: '2026-01-02' },
        last: { value: 72 },
        change: -3,
        count: 2,
      });
      expect(series(overview, 'sleep_hours').first?.value).toBe(0);
      expect(series(overview, 'sleep_hours').change).toBe(7);
      expect(series(overview, 'height_cm').change).toBeNull();
      expect(series(overview, 'neck_cm').first).toBeNull();
      expect(
        overview.series.some((item) => item.key === 'muscle_mass_kg'),
      ).toBe(false);
      expect(series(overview, 'weight_kg').points).toHaveLength(1);
      const old = await metrics.getOverview(id, { ...query, page: 3 });
      expect(series(old, 'weight_kg').points).toHaveLength(1);
      expect(series(old, 'weight_kg').change).toBe(-3);
      const bounded = await metrics.getOverview(id, {
        ...query,
        from: '2026-09-01',
      });
      expect(series(bounded, 'weight_kg').count).toBe(1);
    });

    it('P1-03: ingredient estimates and snapshots survive catalogue edits and diet deletion', async () => {
      const id = await nutritionFixture();
      const before = await metrics.getOverview(id, query);
      expect(series(before, 'calories').first?.value).toBe(200);
      expect(series(before, 'protein_g').first?.value).toBe(10);
      await db.ingredient.update({
        where: { id },
        data: { calories_per_100g: 999 },
      });
      await db.meal.update({
        where: { id: `${id}-variant` },
        data: { calories: 999 },
      });
      await db.diet.delete({ where: { id } });
      expect(await metrics.getOverview(id, query)).toEqual(before);
    });

    it('P1-02/03: alternatives and duplicate ids are never double-counted; missing is not zero', async () => {
      const id = await nutritionFixture();
      const where = {
        client_id_date: { client_id: id, date: new Date('2026-09-01') },
      };
      await db.dayProgress.update({
        where,
        data: { meals_completed: [id, id] },
      });
      expect(
        series(await metrics.getOverview(id, query), 'calories').first?.value,
      ).toBe(350);
      await db.dayProgress.update({
        where,
        data: { meals_completed: [id, `${id}-variant`] },
      });
      const ambiguous = series(
        await metrics.getOverview(id, query),
        'calories',
      );
      expect(ambiguous.first).toBeNull();
      expect(ambiguous.points[0].quality).toBe('missing');
      await db.dayProgress.update({
        where,
        data: { meals_completed: [id, 'unknown-old-meal'] },
      });
      const partial = series(await metrics.getOverview(id, query), 'calories');
      expect(partial.first).toBeNull();
      expect(partial.points[0]).toMatchObject({
        value: 350,
        quality: 'partial',
      });
      await db.dayProgress.update({ where, data: { meals_completed: [] } });
      expect(
        series(await metrics.getOverview(id, query), 'calories').first?.value,
      ).toBe(0);
    });

    it('P1-04/05: old writes preserve optional data, explicit null clears it, drafts are excluded', async () => {
      const id = await user();
      const dates = {
        week_start_date: '2026-09-07',
        week_end_date: '2026-09-13',
      };
      const recap = await recaps.create(id, {
        ...dates,
        hunger_level: 1,
        energy_level: 10,
        digestion_level: 7,
        average_daily_steps: 0,
        stress_enabled: true,
        stress_level: 0,
        sleep_hours_range: 'ENTRE_6_7',
      });
      await recaps.create(id, { ...dates, training_notes: 'Old app retry' });
      await recaps.update(id, recap.id, { digestion_level: null });
      expect(
        series(await metrics.getOverview(id, query), 'hunger_level').count,
      ).toBe(0);
      await recaps.submit(id, recap.id);
      const detail = await recaps.getMyRecapById(id, recap.id);
      expect(detail.hunger_level).toBe(1);
      expect(detail.energy_level).toBe(10);
      expect(detail.digestion_level).toBeNull();
      expect(detail).not.toHaveProperty('admin_comments');
      const overview = await metrics.getOverview(id, query);
      expect(series(overview, 'average_daily_steps').points).toEqual([
        expect.objectContaining({
          value: 0,
          date: '2026-09-07',
          end_date: '2026-09-13',
        }),
      ]);
      expect(series(overview, 'stress_level').first?.value).toBe(0);
      expect(series(overview, 'sleep_hours').first).toBeNull();
    });

    it('P1-06: real ownership/roles protect admin and owner endpoints, including recap writes', async () => {
      const id = await nutritionFixture();
      const other = await user();
      const coach = await user('ADMIN');
      const stranger = await user('ADMIN');
      const superadmin = await user('SUPER_ADMIN');
      await db.adminClientAssignment.create({
        data: { admin_id: coach, client_id: id, is_active: true },
      });
      const server = app.getHttpServer<Server>();
      for (const actor of [coach, superadmin])
        await request(server)
          .get(`/admin/clients/${id}/metrics/overview`)
          .set('x-test-user', actor)
          .query(query)
          .expect(200);
      for (const actor of [stranger, other, id])
        await request(server)
          .get(`/admin/clients/${id}/metrics/overview`)
          .set('x-test-user', actor)
          .query(query)
          .expect(403);
      const own: { body: Overview } = await request(server)
        .get('/metrics/overview')
        .set('x-test-user', id)
        .query(query)
        .expect(200);
      expect(own.body.client_id).toBe(id);
      const theirs: { body: Overview } = await request(server)
        .get('/metrics/overview')
        .set('x-test-user', other)
        .query(query)
        .expect(200);
      expect(series(theirs.body, 'calories').first).toBeNull();
      await request(server)
        .get('/metrics/overview')
        .set('x-test-user', id)
        .query({ ...query, client_id: other })
        .expect(400);
      const recap = await recaps.create(id, {
        week_start_date: '2026-09-07',
        week_end_date: '2026-09-13',
      });
      await request(server)
        .put(`/recaps/${recap.id}`)
        .set('x-test-user', other)
        .send({ hunger_level: 5 })
        .expect(403);
      await request(server)
        .put(`/recaps/${recap.id}`)
        .set('x-test-user', id)
        .send({ hunger_level: 11 })
        .expect(400);
      await request(server)
        .get('/metrics/overview')
        .set('x-test-user', id)
        .query({ from: '2026-02-30' })
        .expect(400);
    });

    it('P1-01: more than one query batch preserves comparison and chart bounds', async () => {
      const id = await user();
      const start = Date.parse('2025-01-01');
      await db.bodyMetric.createMany({
        data: Array.from({ length: 260 }, (_, index) => ({
          client_id: id,
          date: new Date(start + index * 86400000),
          weight_kg: 80 - index / 100,
        })),
      });
      const overview = await metrics.getOverview(id, {
        to: '2025-09-17',
        page: 1,
      });
      expect(overview.from).toBe('2025-01-01');
      expect(series(overview, 'weight_kg')).toMatchObject({
        count: 260,
        change: -2.59,
      });
      expect(series(overview, 'weight_kg').points).toHaveLength(90);
    });

    it('P1-01/03: repeatable read cannot mix concurrent metric versions', async () => {
      const id = await user();
      const metric = await db.bodyMetric.create({
        data: { client_id: id, date: new Date('2026-09-01'), weight_kg: 70 },
      });
      const overview = await db.$transaction(
        async (tx) => {
          await tx.bodyMetric.findFirst({ where: { client_id: id } }); // establish snapshot before concurrent commit
          await db.bodyMetric.update({
            where: { id: metric.id },
            data: { weight_kg: 80 },
          });
          return metricsOverview(tx, id, query);
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      );
      expect(series(overview, 'weight_kg').first?.value).toBe(70);
      expect(
        series(await metrics.getOverview(id, query), 'weight_kg').first?.value,
      ).toBe(80);
    });
  },
);
