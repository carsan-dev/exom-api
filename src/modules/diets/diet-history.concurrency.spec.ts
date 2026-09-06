import { Test, TestingModule } from '@nestjs/testing';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaService } from '../../prisma/prisma.service';
import { loadDietHistory } from '../../common/progress/diet-history';
import { lockClientDayProgress } from '../../common/progress/day-progress-lock';
import { DietsService } from './diets.service';
import { MealsService } from '../meals/meals.service';
import { ProgressService } from '../progress/progress.service';
import { CalendarService } from '../calendar/calendar.service';
import { UsersService } from '../users/users.service';
import { MetricsService } from '../metrics/metrics.service';
import { ChallengesService } from '../challenges/challenges.service';
import { AchievementsService } from '../achievements/achievements.service';
import { NotificationsService } from '../notifications/notifications.service';
import { StreakCalculatorService } from '../streaks/streak-calculator.service';
import { UploadsService } from '../uploads/uploads.service';
import { AutoAssignmentMaterializerService } from '../assignments/auto-assignment-materializer.service';

const databaseUrl = process.env.TEST_DATABASE_URL ?? '';
const suite = databaseUrl ? describe : describe.skip;
const future = new Date('2099-01-05T00:00:00Z');
const past = new Date('2000-01-03T00:00:00Z');
const key = (date: Date) => date.toISOString().slice(0, 10);

suite('Diet history PostgreSQL integrity', () => {
  const prefix = `diet-history-${process.pid}-${Date.now()}`;
  let sequence = 0;
  const fixtures: string[] = [];
  let pool: Pool;
  let otherPool: Pool;
  let db: PrismaClient;
  let other: PrismaClient;
  let module: TestingModule;
  let otherModule: TestingModule;

  async function services(prisma: PrismaClient) {
    return Test.createTestingModule({
      providers: [
        DietsService,
        MealsService,
        ProgressService,
        CalendarService,
        UsersService,
        { provide: PrismaService, useValue: prisma },
        { provide: MetricsService, useValue: {} },
        { provide: UploadsService, useValue: {} },
        {
          provide: ChallengesService,
          useValue: { recalculateAutomaticProgress: jest.fn() },
        },
        {
          provide: AchievementsService,
          useValue: { evaluateAutomaticAchievementsForUser: jest.fn() },
        },
        {
          provide: NotificationsService,
          useValue: { findSystemSenderId: jest.fn().mockResolvedValue(null) },
        },
        {
          provide: StreakCalculatorService,
          useValue: {
            recalculateClient: jest.fn().mockResolvedValue({ changed: false }),
          },
        },
        // Fixtures explicitly materialize plans. No cron, Firebase, FCM or email.
        {
          provide: AutoAssignmentMaterializerService,
          useValue: { reconcile: jest.fn() },
        },
      ],
    }).compile();
  }

  beforeAll(async () => {
    const target = new URL(databaseUrl);
    if (
      !['127.0.0.1', 'localhost'].includes(target.hostname) ||
      target.pathname !== '/exom_review'
    ) {
      throw new Error(
        'Requires the explicitly disposable local exom_review database',
      );
    }
    pool = new Pool({
      connectionString: databaseUrl,
      application_name: prefix,
    });
    otherPool = new Pool({
      connectionString: databaseUrl,
      application_name: `${prefix}-other`,
    });
    db = new PrismaClient({ adapter: new PrismaPg(pool) });
    other = new PrismaClient({ adapter: new PrismaPg(otherPool) });
    module = await services(db);
    otherModule = await services(other);
  });

  afterAll(async () => {
    // Exact fixture IDs only. Client cascade owns historical snapshots.
    for (const id of fixtures) {
      await db.user.deleteMany({ where: { id } });
      await db.diet.deleteMany({
        where: { id: { in: [id, `${id}-replacement`] } },
      });
      await db.ingredient.deleteMany({ where: { id } });
    }
    await module?.close();
    await otherModule?.close();
    await db?.$disconnect();
    await other?.$disconnect();
    await pool?.end();
    await otherPool?.end();
  });

  async function fixture(date = future) {
    const id = `${prefix}-${++sequence}`;
    fixtures.push(id);
    await db.user.create({
      data: { id, email: `${id}@example.test`, firebase_uid: id },
    });
    await db.ingredient.create({
      data: {
        id,
        name: 'Avena original',
        calories_per_100g: 380,
        protein_per_100g: 13,
        carbs_per_100g: 60,
        fat_per_100g: 7,
      },
    });
    await db.diet.create({
      data: { id, name: 'Dieta original', total_calories: 700 },
    });
    await db.meal.create({
      data: {
        id,
        diet_id: id,
        name: 'Desayuno original',
        type: 'BREAKFAST',
        calories: 350,
        protein_g: 20,
        carbs_g: 40,
        fat_g: 10,
        nutritional_badges: ['fibra'],
        ingredients: {
          create: {
            ingredient_id: id,
            quantity: 2,
            unit: 'cup',
            grams_equivalent: 80,
          },
        },
      },
    });
    await db.meal.create({
      data: {
        id: `${id}-variant`,
        diet_id: id,
        parent_meal_id: id,
        name: 'Alternativa original',
        type: 'BREAKFAST',
        calories: 320,
        nutritional_badges: [],
      },
    });
    await db.planAssignment.create({
      data: { id, client_id: id, date, diet_id: id },
    });
    return { id, date, variant: `${id}-variant` };
  }

  async function mark(
    f: Awaited<ReturnType<typeof fixture>>,
    mealId = f.id,
    service = module.get(ProgressService),
  ) {
    return service.markMealCompleted(f.id, {
      meal_id: mealId,
      date: key(f.date),
    });
  }

  async function snapshot(f: Awaited<ReturnType<typeof fixture>>) {
    const rows = await loadDietHistory(db, [f.id], f.date);
    expect(rows).toHaveLength(1);
    return rows[0];
  }

  it('preserves full past content through real DietsService replacement; future stays live', async () => {
    const f = await fixture(past);
    await db.planAssignment.create({
      data: { client_id: f.id, date: future, diet_id: f.id },
    });
    await mark(f, f.variant);
    const original = await snapshot(f);
    await module
      .get(DietsService)
      .update(f.id, { name: 'Nueva dieta', meals: [] });
    expect(await db.meal.count({ where: { diet_id: f.id } })).toBe(0);
    expect(await snapshot(f)).toEqual(original);
    const diet = await module.get(DietsService).findToday(f.id, f.date);
    expect(diet?.name).toBe('Dieta original');
    expect(diet?.meals[0]).toMatchObject({
      name: 'Desayuno original',
      calories: 350,
      protein_g: 20,
      carbs_g: 40,
      fat_g: 10,
    });
    expect(diet?.meals[0].ingredients[0]).toMatchObject({
      quantity: 2,
      unit: 'cup',
      grams_equivalent: 80,
      ingredient: { name: 'Avena original', calories_per_100g: 380 },
    });
    expect(diet?.meals[0].variants[0].id).toBe(f.variant);
    expect(
      (await module.get(DietsService).findToday(f.id, future))?.meals,
    ).toEqual([]);
    expect(await loadDietHistory(db, [f.id], future)).toEqual([]);
    // Retry and switching alternatives use frozen occurrence IDs after deletion.
    await mark(f, f.variant);
    await mark(f);
    expect(
      (
        await db.dayProgress.findUniqueOrThrow({
          where: { client_id_date: { client_id: f.id, date: f.date } },
        })
      ).meals_completed,
    ).toEqual([f.id]);
    expect(
      await module.get(CalendarService).getWeekSummary(f.id, key(past)),
    ).toMatchObject({ total_meals: 1, meals_completed: 1 });
    const week = await module.get(DietsService).findWeek(f.id, past);
    expect(week.days[0].diet?.meals[0].name).toBe('Desayuno original');
    const admin = await module
      .get(UsersService)
      .getClientDayProgress('test-admin', 'SUPER_ADMIN', f.id, key(past));
    expect(admin?.meals_completed_details).toEqual([
      { meal_id: f.id, meal_name: 'Desayuno original' },
    ]);
    expect(admin?.diet_history).toHaveLength(1);
  });

  it('captures today with partial exercise progress; direct meal/ingredient edits and deletion cannot rewrite it', async () => {
    const today = new Date(
      `${new Date().toISOString().slice(0, 10)}T00:00:00Z`,
    );
    const f = await fixture(today);
    await db.dayProgress.create({
      data: {
        client_id: f.id,
        date: f.date,
        meals_completed: [],
        exercises_completed: [
          {
            exercise_id: 'historic',
            sets: [{ set_number: 1, reps: 4, rir: 2 }],
          },
        ],
      },
    });
    const original = await snapshot(f);
    await db.ingredient.update({
      where: { id: f.id },
      data: { name: 'Ingrediente cambiado', calories_per_100g: 999 },
    });
    await module.get(MealsService).update(f.id, { name: 'Comida cambiada' });
    await db.mealIngredient.updateMany({
      where: { meal_id: f.id },
      data: { quantity: 9 },
    });
    await module.get(MealsService).remove(f.id);
    expect(await snapshot(f)).toEqual(original);
    await mark(f, f.variant);
  });

  it('keeps past without progress, soft delete exception, empty override and physical deletion history separate', async () => {
    const f = await fixture(past);
    const original = await snapshot(f);
    await db.diet.update({ where: { id: f.id }, data: { is_active: false } });
    expect((await module.get(DietsService).findToday(f.id, past))?.name).toBe(
      'Dieta original',
    );
    await expect(module.get(DietsService).findOne(f.id)).rejects.toThrow();
    await db.planAssignment.update({
      where: { id: f.id },
      data: { diet_id: null },
    });
    expect(await module.get(DietsService).findToday(f.id, past)).toBeNull();
    await db.diet.delete({ where: { id: f.id } });
    expect(await snapshot(f)).toEqual(original);
    const progress = await module
      .get(ProgressService)
      .getDayProgress(f.id, key(past));
    expect(progress.diet_history[0].diet.meals[0].name).toBe(
      'Desayuno original',
    );
    expect(progress.diet_history[0].diet).not.toHaveProperty('tags');
    expect(await loadDietHistory(db, ['another-client'], past)).toEqual([]);
  });

  it('preserves both explicit assignments without attributing old completion to the replacement', async () => {
    const f = await fixture(past);
    await mark(f);
    await db.diet.create({
      data: { id: `${f.id}-replacement`, name: 'Replacement' },
    });
    await db.planAssignment.update({
      where: { id: f.id },
      data: { diet_id: `${f.id}-replacement` },
    });
    expect((await module.get(DietsService).findToday(f.id, past))?.name).toBe(
      'Replacement',
    );
    expect(await loadDietHistory(db, [f.id], past)).toHaveLength(2);
    expect(
      await module.get(CalendarService).getWeekSummary(f.id, key(past)),
    ).toMatchObject({ total_meals: 0, meals_completed: 0 });
  });

  it('rolls back first progress and its snapshot together; retries never update content/timestamp', async () => {
    const f = await fixture();
    await expect(
      db.$transaction(async (tx) => {
        await lockClientDayProgress(tx, f.id);
        await tx.dayProgress.create({
          data: { client_id: f.id, date: f.date, meals_completed: [f.id] },
        });
        throw new Error('rollback fixture');
      }),
    ).rejects.toThrow('rollback fixture');
    expect(await loadDietHistory(db, [f.id], future)).toEqual([]);
    await mark(f);
    const original = await snapshot(f);
    await mark(f);
    expect(await snapshot(f)).toEqual(original);
    await expect(
      db.dietDaySnapshot.update({
        where: {
          client_id_date_diet_id: {
            client_id: f.id,
            date: f.date,
            diet_id: f.id,
          },
        },
        data: { diet: {} },
      }),
    ).rejects.toThrow();
    await expect(
      db.dietDaySnapshot.deleteMany({ where: { client_id: f.id } }),
    ).rejects.toThrow();
    expect(await snapshot(f)).toEqual(original);
  });

  async function dayThatBecamePast() {
    const f = await fixture();
    // Fixture-only clock transition: a future assignment ages without a write.
    // Move its date with ONLY the capture-after trigger temporarily suspended
    // inside this isolated transaction; restore it before testing any writer.
    // This models midnight, and ensures an absent snapshot before the mutation.
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'ALTER TABLE plan_assignments DISABLE TRIGGER diet_history_assignment_after',
      );
      await tx.planAssignment.update({
        where: { id: f.id },
        data: { date: past },
      });
      await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
      await tx.$executeRawUnsafe(
        'ALTER TABLE plan_assignments ENABLE TRIGGER diet_history_assignment_after',
      );
    });
    f.date = past;
    expect(await loadDietHistory(db, [f.id], past)).toEqual([]);
    return f;
  }

  it.each(['diet', 'meal', 'mealIngredient', 'ingredient', 'mealInsert'])(
    'captures before %s changes a past day that has never had progress or a snapshot',
    async (writer) => {
      const f = await dayThatBecamePast();
      if (writer === 'diet')
        await module.get(DietsService).update(f.id, { meals: [] });
      if (writer === 'meal') await module.get(MealsService).remove(f.id);
      if (writer === 'mealIngredient')
        await db.mealIngredient.deleteMany({ where: { meal_id: f.id } });
      if (writer === 'ingredient')
        await db.ingredient.update({
          where: { id: f.id },
          data: { name: 'Edited ingredient' },
        });
      if (writer === 'mealInsert')
        await db.meal.create({
          data: {
            diet_id: f.id,
            name: 'Added later',
            type: 'DINNER',
            nutritional_badges: [],
          },
        });
      const preserved = (await snapshot(f)).diet;
      expect(preserved.meals).toHaveLength(1);
      expect(preserved.meals[0].name).toBe('Desayuno original');
      expect(preserved.meals[0].ingredients[0].ingredient.name).toBe(
        'Avena original',
      );
      expect(preserved.meals[0].ingredients[0].quantity).toBe(2);
      expect(preserved.meals[0].variants[0].id).toBe(f.variant);
    },
  );

  it('a rolled-back catalog mutation leaves neither changed content nor an orphan snapshot', async () => {
    const f = await dayThatBecamePast();
    await expect(
      db.$transaction(async (tx) => {
        await tx.meal.update({
          where: { id: f.id },
          data: { name: 'Rollback' },
        });
        expect(await loadDietHistory(tx, [f.id], past)).toHaveLength(1);
        throw new Error('catalog rollback');
      }),
    ).rejects.toThrow('catalog rollback');
    expect(await loadDietHistory(db, [f.id], past)).toEqual([]);
    expect(
      (await db.meal.findUniqueOrThrow({ where: { id: f.id } })).name,
    ).toBe('Desayuno original');
  });

  async function waitForBlockedOther() {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const result = await pool.query<{ blocked: boolean }>(
        'SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND cardinality(pg_blocking_pids(pid)) > 0) AS blocked',
        [`${prefix}-other`],
      );
      if (result.rows[0].blocked) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(
      'Required interleaving was not observed in pg_blocking_pids',
    );
  }

  it('first progress holds the barrier before a catalog edit: old content survives actual lock waiting', async () => {
    const f = await fixture();
    let editing: Promise<unknown> | undefined;
    await db.$transaction(async (tx) => {
      await lockClientDayProgress(tx, f.id);
      editing = other.meal
        .update({ where: { id: f.id }, data: { name: 'Concurrent edit' } })
        .then((value) => value);
      await waitForBlockedOther();
      await tx.dayProgress.create({
        data: { client_id: f.id, date: f.date, meals_completed: [f.id] },
      });
    });
    await editing;
    expect((await snapshot(f)).diet.meals[0].name).toBe('Desayuno original');
    expect(
      (await db.meal.findUniqueOrThrow({ where: { id: f.id } })).name,
    ).toBe('Concurrent edit');
  });

  it('catalog edit commits first: real completion waits and captures the new content, without a deadlock', async () => {
    const f = await fixture();
    let completing: Promise<unknown> | undefined;
    await db.$transaction(async (tx) => {
      await tx.meal.update({
        where: { id: f.id },
        data: { name: 'New before start' },
      });
      completing = mark(f, f.id, otherModule.get(ProgressService));
      await waitForBlockedOther();
    });
    await completing;
    expect((await snapshot(f)).diet.meals[0].name).toBe('New before start');
  });
});
