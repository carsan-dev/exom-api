import { PrismaClient, Prisma, Role, Level, MealType } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { UsersService } from '../modules/users/users.service';
import { IngredientsService } from '../modules/ingredients/ingredients.service';
import { ExercisesService } from '../modules/exercises/exercises.service';
import { DietsService } from '../modules/diets/diets.service';
import { TrainingsService } from '../modules/trainings/trainings.service';
import { AdminUsersQueryDto } from '../modules/users/dto/admin-users-query.dto';
import { AdminClientsQueryDto } from '../modules/users/dto/admin-clients-query.dto';
import { IngredientsQueryDto } from '../modules/ingredients/dto/ingredients-query.dto';
import { ExercisesQueryDto } from '../modules/exercises/dto/exercises-query.dto';
import { DietsQueryDto } from '../modules/diets/dto/diets-query.dto';
import { TrainingsQueryDto } from '../modules/trainings/dto/trainings-query.dto';
import { PrismaService } from './prisma.service';
import { databasePoolConfig } from './pool-config';
import { userPage } from '../modules/users/users-list-query';
import { FeedbackService } from '../modules/feedback/feedback.service';
import { DashboardService } from '../modules/dashboard/dashboard.service';
import { RecapsService } from '../modules/recaps/recaps.service';
import { ChallengesService } from '../modules/challenges/challenges.service';
import { AdminRecapQueryDto } from '../modules/recaps/dto/admin-recap-query.dto';
import {
  ChallengesQueryDto,
  ChallengeAssignmentsQueryDto,
} from '../modules/challenges/dto/challenges-query.dto';

const enabled = process.env.PHASE8_DATABASE_URL;
const normalize = (s: string) =>
  s
    .toLocaleLowerCase('es-ES')
    .normalize('NFD')
    .replace(/([aeiou])([\u0300-\u036f]+)/g, '$1')
    .normalize('NFC');
const names = [
  'Áda Ñúñez',
  'Ada Nunez',
  'ÁDA ÑÚÑEZ',
  '100% _ \\',
  "O'Neil",
  'Ürsula',
  'Ada',
  'A\u0301da Ñúñez',
];
const date = new Date('2026-01-10T10:00:00Z');

(enabled ? describe : describe.skip)(
  'P8 data access on isolated PostgreSQL',
  () => {
    let db: PrismaClient;
    let pool: Pool;
    let users: UsersService;
    let ingredients: IngredientsService;
    let exercises: ExercisesService;
    let diets: DietsService;
    let trainings: TrainingsService;
    beforeAll(async () => {
      const url = new URL(enabled!);
      if (
        url.hostname !== '127.0.0.1' ||
        url.port !== '55448' ||
        url.pathname !== '/phase8'
      )
        throw new Error('Use the identified phase8 disposable database');
      pool = new Pool(
        databasePoolConfig({
          DATABASE_URL: enabled,
          DATABASE_SSL_MODE: 'disable',
          NODE_ENV: 'test',
          DATABASE_POOL_MAX: '4',
        }),
      );
      const identity = await pool.query<{ data_directory: string }>(
        'SHOW data_directory',
      );
      if (
        !String(identity.rows[0].data_directory)
          .replaceAll('\\', '/')
          .endsWith('/docs/operations/phase8-20260912/pgdata')
      )
        throw new Error('Wrong cluster');
      db = new PrismaClient({ adapter: new PrismaPg(pool) });
      const serviceDb = db as PrismaService;
      users = new UsersService(
        serviceDb,
        undefined as never,
        undefined as never,
        undefined as never,
        undefined as never,
      );
      ingredients = new IngredientsService(serviceDb);
      exercises = new ExercisesService(serviceDb);
      diets = new DietsService(
        serviceDb,
        undefined as never,
        undefined as never,
      );
      trainings = new TrainingsService(serviceDb, undefined as never);
      // Unique synthetic population; delete only this prefix to make the suite repeatable.
      await db.training.deleteMany({
        where: { id: { startsWith: 'p8-test-' } },
      });
      await db.exercise.deleteMany({
        where: { id: { startsWith: 'p8-test-' } },
      });
      await db.diet.deleteMany({ where: { id: { startsWith: 'p8-test-' } } });
      await db.ingredient.deleteMany({
        where: { id: { startsWith: 'p8-test-' } },
      });
      await db.user.deleteMany({ where: { id: { startsWith: 'p8-test-' } } });
      await db.user.create({
        data: {
          id: 'p8-test-admin',
          email: 'p8-admin@example.test',
          firebase_uid: 'p8-test-admin',
          role: Role.ADMIN,
        },
      });
      for (let i = 0; i < names.length; i++) {
        const id = `p8-test-${i}`;
        await db.user.create({
          data: {
            id,
            email: `p8-${i}@example.test`,
            firebase_uid: id,
            role: Role.CLIENT,
            created_at: date,
            is_active: i % 3 !== 0,
            is_locked: i % 3 === 2,
            is_archived: i % 2 === 0,
            ...(i !== 6
              ? {
                  profile: {
                    create: {
                      first_name: names[i].split(' ')[0],
                      last_name: names[i].split(' ').slice(1).join(' '),
                      level: Level.INTERMEDIO,
                    },
                  },
                }
              : {}),
          },
        });
        if (i % 2 === 0)
          await db.adminClientAssignment.create({
            data: {
              id: `p8-test-assignment-${7 - i}`,
              admin_id: 'p8-test-admin',
              client_id: id,
              created_at: date,
            },
          });
        await db.ingredient.create({
          data: {
            id,
            name: names[i],
            icon: i % 2 ? '' : null,
            calories_per_100g: i * 10,
            protein_per_100g: i,
            carbs_per_100g: i,
            fat_per_100g: i,
            updated_at: date,
          },
        });
        await db.exercise.create({
          data: {
            id,
            name: names[i],
            muscle_groups: ['Pierna'],
            equipment: ['Barra'],
            video_url: i % 2 ? '' : 'fixture',
            updated_at: date,
          },
        });
        await db.training.create({
          data: {
            id,
            name: names[i],
            type: 'FUERZA',
            types: [],
            tags: ['f8'],
            estimated_duration_min: i * 10,
            updated_at: date,
            exercises: {
              create: [
                { exercise_id: id, order: 1, sets: 3, reps_or_duration: '12' },
                { exercise_id: id, order: 2, sets: 3, reps_or_duration: '12' },
              ],
            },
          },
        });
        await db.diet.create({
          data: {
            id,
            name: names[i],
            tags: ['f8'],
            updated_at: date,
            meals: {
              create: {
                name: 'fixture',
                type: MealType.DINNER,
                nutritional_badges: ['f8'],
              },
            },
          },
        });
      }
      await db.training.update({
        where: { id: 'p8-test-7' },
        data: { is_active: false },
      });
    }, 30000);
    afterAll(async () => {
      if (db) await db.$disconnect();
      if (pool) await pool.end();
    });

    it.each([
      ...names,
      'Çç',
      'İı',
      'ΣΟΣ',
      'a\u0301\u0302',
      'ñ n',
      'A\u0303',
      'Ææ',
    ])('preserves JavaScript Spanish normalization: %s', async (value) => {
      const rows = await db.$queryRaw<
        Array<{ value: string }>
      >`SELECT public.exom_normalize_search(${value}) AS value`;
      expect(rows[0].value).toBe(normalize(value));
    });

    it.each([
      'ada',
      'ñ',
      'nunez',
      '%',
      '_',
      '\\',
      "o'",
      'example.test áda',
      '  ',
      'missing',
      'p8-6@example.test',
    ])(
      'global users: literal/combined search, ties, successive and empty pages: %s',
      async (search) => {
        const source = await db.user.findMany({
          where: { role: Role.CLIENT },
          include: { profile: true },
          orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        });
        const expected = source
          .filter((u) =>
            normalize(
              [u.email, u.profile?.first_name, u.profile?.last_name]
                .filter(Boolean)
                .join(' '),
            ).includes(normalize(search.trim())),
          )
          .map((u) => u.id);
        const received: string[] = [];
        for (let page = 1; page <= Math.ceil(expected.length / 2) + 1; page++) {
          const result = await users.findAll(
            Object.assign(new AdminUsersQueryDto(), {
              role: Role.CLIENT,
              search,
              page,
              limit: 2,
            }),
          );
          expect(result.total).toBe(expected.length);
          received.push(...result.data.map((u) => u.id));
        }
        expect(received).toEqual(expected);
      },
    );

    it.each(['ACTIVE', 'INACTIVE', 'LOCKED'] as const)(
      'client filters preserve status precedence and own-assignment ordering: %s',
      async (status) => {
        for (const role of [Role.ADMIN, Role.SUPER_ADMIN]) {
          const result = await users.getMyClients(
            'p8-test-admin',
            role,
            Object.assign(new AdminClientsQueryDto(), {
              status: [status],
              assignment_state: ['ASSIGNED'],
              archive: 'archived',
              level: [Level.INTERMEDIO],
              created_from: '2026-01-01',
              created_to: '2026-01-31',
              limit: 20,
            }),
          );
          const source = await db.adminClientAssignment.findMany({
            where: { admin_id: 'p8-test-admin' },
            include: { client: { include: { profile: true } } },
            orderBy:
              role === Role.ADMIN
                ? [{ created_at: 'desc' }, { id: 'desc' }]
                : [{ client: { created_at: 'desc' } }, { client_id: 'desc' }],
          });
          const expected = source
            .filter(
              ({ client: u }) =>
                u.profile &&
                (u.is_locked
                  ? 'LOCKED'
                  : u.is_active
                    ? 'ACTIVE'
                    : 'INACTIVE') === status,
            )
            .map((a) => a.client_id);
          expect(result.data.map((u) => u.id)).toEqual(expected);
          expect(result.data.every((u) => u.active_admins_count === 1)).toBe(
            true,
          );
        }
      },
    );

    it('does not download filtered user populations to Node', async () => {
      const spy = jest.spyOn(db.user, 'findMany');
      await users.findAll(
        Object.assign(new AdminUsersQueryDto(), {
          search: 'example.test',
          limit: 2,
        }),
      );
      expect(
        spy.mock.calls.every(
          ([args]) => args?.where && Object.keys(args.where).length > 0,
        ),
      ).toBe(true);
      for (const [args] of spy.mock.calls)
        expect(args?.where?.id).toHaveProperty('in', expect.any(Array));
      spy.mockRestore();
    });

    it('keeps page, total and hydration on one snapshot across a concurrent update', async () => {
      const before = await db.user.findUniqueOrThrow({
        where: { id: 'p8-test-0' },
      });
      await db.$transaction(
        async (tx) => {
          const page = await userPage(
            tx,
            Object.assign(new AdminUsersQueryDto(), { search: before.email }),
          );
          await db.user.update({
            where: { id: before.id },
            data: { email: 'changed-p8@example.test' },
          });
          const hydrated = await tx.user.findMany({
            where: { id: { in: page.ids } },
          });
          expect(page.total).toBe(1);
          expect(hydrated[0].email).toBe(before.email);
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      );
      await db.user.update({
        where: { id: before.id },
        data: { email: before.email },
      });
    });

    it('treats repeated assignment filters like the same single filter', async () => {
      const single = await users.getMyClients(
        'p8-test-admin',
        Role.SUPER_ADMIN,
        Object.assign(new AdminClientsQueryDto(), {
          assignment_state: ['UNASSIGNED'],
        }),
      );
      const repeated = await users.getMyClients(
        'p8-test-admin',
        Role.SUPER_ADMIN,
        Object.assign(new AdminClientsQueryDto(), {
          assignment_state: ['UNASSIGNED', 'UNASSIGNED'],
        }),
      );
      expect(repeated).toEqual(single);
    });

    it('feedback scope and tied pages use relational authorization without enumerating clients', async () => {
      const service = new FeedbackService(
        db as PrismaService,
        undefined as never,
        undefined as never,
      );
      await db.feedbackMedia.deleteMany({
        where: { id: { startsWith: 'p8-test-feedback-' } },
      });
      for (let i = 0; i < 4; i++)
        await db.feedbackMedia.create({
          data: {
            id: `p8-test-feedback-${i}`,
            client_id: `p8-test-${i}`,
            media_type: 'IMAGE',
            created_at: date,
          },
        });
      const query = { page: 1, limit: 1, skip: 0 };
      const own = await service.findAll('p8-test-admin', Role.ADMIN, query);
      const next = await service.findAll('p8-test-admin', Role.ADMIN, {
        ...query,
        page: 2,
        skip: 1,
      });
      expect(own.total).toBe(2);
      expect(own.data[0].id).toBe('p8-test-feedback-2');
      expect(next.data[0].id).toBe('p8-test-feedback-0');
      const forbidden = await service.findAll('p8-test-admin', Role.ADMIN, {
        ...query,
        client_id: 'p8-test-1',
      });
      expect(forbidden.total).toBe(0);
      expect((await service.findAll('unknown', Role.CLIENT, query)).total).toBe(
        0,
      );
      expect((await service.getStats('p8-test-admin', Role.ADMIN)).total).toBe(
        2,
      );
      expect(
        (await service.getStats('p8-test-admin', Role.SUPER_ADMIN)).total,
      ).toBe(4);
    });

    it.each(['ada', 'ñ', '%', '_', '\\', "o'", 'missing'])(
      'catalog search matches legacy normalization with bounded pages: %s',
      async (search) => {
        const expected = names
          .map((name, i) => ({ id: `p8-test-${i}`, name }))
          .filter((r) => normalize(r.name).includes(normalize(search)))
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((r) => r.id);
        const gathered: string[] = [];
        for (let page = 1; page <= Math.ceil(expected.length / 2) + 1; page++) {
          const result = await ingredients.findAll(
            Object.assign(new IngredientsQueryDto(), {
              search,
              page,
              limit: 2,
              sort_by: 'updated_at',
              sort_dir: 'asc',
            }),
          );
          gathered.push(...result.data.map((r) => r.id));
          expect(result.total).toBe(expected.length);
        }
        expect(gathered).toEqual(expected);
        const dietResult = await diets.findAll(
          Object.assign(new DietsQueryDto(), {
            search,
            tags: ['f8'],
            meal_types: [MealType.DINNER],
            nutritional_badges: ['f8'],
            updated_from: '2026-01-10',
            updated_to: '2026-01-10',
            limit: 20,
            sort_by: 'updated_at',
            sort_dir: 'asc',
          }),
        );
        expect(dietResult.data.map((r) => r.id)).toEqual(expected);
        const trainingResult = await trainings.findAll(
          Object.assign(new TrainingsQueryDto(), {
            search,
            type: ['FUERZA'],
            tags: ['f8'],
            level: [Level.PRINCIPIANTE],
            duration_min: 0,
            duration_max: 60,
            limit: 20,
            sort_by: 'updated_at',
            sort_dir: 'asc',
          }),
        );
        expect(trainingResult.data.map((r) => r.id)).toEqual(
          expected.filter((id) => id !== 'p8-test-7'),
        );
      },
    );

    it('counts DISTINCT active trainings and sorts usage/video before pagination', async () => {
      const used = await exercises.findAll(
        Object.assign(new ExercisesQueryDto(), {
          training_usage: 'used',
          limit: 3,
          page: 2,
          sort_by: 'training_usage_count',
          sort_dir: 'asc',
        }),
      );
      expect(used.total).toBe(7);
      expect(used.data.map((e) => e.id)).toEqual([
        'p8-test-3',
        'p8-test-4',
        'p8-test-5',
      ]);
      expect(used.data.every((e) => e.training_usage_count === 1)).toBe(true);
      const unused = await exercises.findAll(
        Object.assign(new ExercisesQueryDto(), { training_usage: 'unused' }),
      );
      expect(unused.data.map((e) => e.id)).toEqual(['p8-test-7']);
      const videos = await exercises.findAll(
        Object.assign(new ExercisesQueryDto(), {
          sort_by: 'video',
          sort_dir: 'desc',
          limit: 2,
          page: 2,
        }),
      );
      expect(videos.data.map((e) => e.id)).toEqual(['p8-test-2', 'p8-test-0']);
    });

    it('honors filtered icon/range and empty pages', async () => {
      const result = await ingredients.findAll(
        Object.assign(new IngredientsQueryDto(), {
          search: 'ada',
          has_icon: ['WITH_ICON'],
          calories_per_100g_min: 10,
          calories_per_100g_max: 80,
          sort_by: 'updated_at',
        }),
      );
      expect(result.data.map((r) => r.id)).toEqual(['p8-test-1', 'p8-test-7']);
    });

    it('dashboard aggregates in SQL and preserves names, weekly scope and the top-five limit', async () => {
      const start = new Date();
      start.setUTCHours(0, 0, 0, 0);
      start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
      await db.dayProgress.deleteMany({
        where: { id: { startsWith: 'p8-test-dashboard-' } },
      });
      for (let i = 0; i < 8; i++)
        for (let day = 0; day < (i === 0 ? 2 : 1); day++) {
          const date = new Date(start);
          date.setUTCDate(date.getUTCDate() + day);
          await db.dayProgress.create({
            data: {
              id: `p8-test-dashboard-${i}-${day}`,
              client_id: `p8-test-${i}`,
              date,
              training_completed: true,
              meals_completed: [],
            },
          });
        }
      const dashboard = new DashboardService(db as PrismaService);
      const result = await dashboard.getAdminDashboard('p8-test-admin');
      expect(result.topClients).toHaveLength(4); // Only this admin's assigned clients.
      expect(result.topClients[0]).toMatchObject({
        clientId: 'p8-test-0',
        clientName: 'Áda Ñúñez',
        completedDays: 2,
        currentStreak: 0,
      });
      expect(result.topClients.map((r) => r.clientId).sort()).toEqual([
        'p8-test-0',
        'p8-test-2',
        'p8-test-4',
        'p8-test-6',
      ]);
    });

    it('pool enforces max, acquisition deadline, release recovery and idle eviction', async () => {
      const small = new Pool(
        databasePoolConfig({
          DATABASE_URL: enabled,
          NODE_ENV: 'test',
          DATABASE_SSL_MODE: 'disable',
          DATABASE_POOL_MAX: '2',
          DATABASE_POOL_CONNECTION_TIMEOUT_MS: '100',
          DATABASE_POOL_IDLE_TIMEOUT_MS: '50',
        }),
      );
      const first = await small.connect(),
        second = await small.connect();
      let firstReleased = false,
        secondReleased = false;
      try {
        const started = Date.now();
        await expect(small.connect()).rejects.toThrow();
        expect(Date.now() - started).toBeGreaterThanOrEqual(80);
        expect(small.totalCount).toBe(2);
        second.release();
        secondReleased = true;
        expect(
          (await small.query<{ value: number }>('SELECT 1 value')).rows[0]
            .value,
        ).toBe(1);
        first.release();
        firstReleased = true;
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(small.totalCount).toBe(0);
      } finally {
        if (!firstReleased) first.release();
        if (!secondReleased) second.release();
        await small.end();
      }
    });

    it('recaps and challenge Admin readers retain authorization and completion semantics in SQL', async () => {
      const recaps = new RecapsService(db as PrismaService, undefined as never);
      const challenges = new ChallengesService(
        db as PrismaService,
        undefined as never,
        undefined as never,
      );
      await db.weeklyRecap.deleteMany({
        where: { id: { startsWith: 'p8-test-recap-' } },
      });
      await db.challenge.deleteMany({
        where: { id: { startsWith: 'p8-test-challenge-' } },
      });
      for (let i = 0; i < 4; i++) {
        await db.weeklyRecap.create({
          data: {
            id: `p8-test-recap-${i}`,
            client_id: `p8-test-${i}`,
            week_start_date: new Date('2026-01-05'),
            week_end_date: new Date('2026-01-11'),
            status: 'SUBMITTED',
          },
        });
        await db.challenge.create({
          data: {
            id: `p8-test-challenge-${i}`,
            title: `scope fixture ${i}`,
            description: 'fixture',
            target_value: 2,
            unit: 'days',
            created_by: 'p8-test-admin',
            created_at: date,
            is_manual: true,
            ...(i < 3
              ? {
                  clients: {
                    create: {
                      id: `p8-test-challenge-assignment-${i}`,
                      client_id: `p8-test-${i}`,
                      is_completed: i === 0,
                    },
                  },
                }
              : {}),
          },
        });
      }
      const list = await recaps.findForAdmin(
        'p8-test-admin',
        Role.ADMIN,
        Object.assign(new AdminRecapQueryDto(), { limit: 1, page: 2 }),
      );
      expect(list.total).toBe(2);
      expect(list.data[0].id).toBe('p8-test-recap-0');
      expect(
        (
          await recaps.findForAdmin(
            'p8-test-admin',
            Role.ADMIN,
            Object.assign(new AdminRecapQueryDto(), { client_id: 'p8-test-1' }),
          )
        ).total,
      ).toBe(0);
      expect((await recaps.getStats('p8-test-admin', Role.ADMIN)).total).toBe(
        2,
      );
      for (const [status, expected] of [
        ['COMPLETED', ['p8-test-challenge-0']],
        ['IN_PROGRESS', ['p8-test-challenge-2']],
        ['NOT_ASSIGNED', ['p8-test-challenge-3', 'p8-test-challenge-1']],
      ] as const) {
        const result = await challenges.findAllForAdmin(
          'p8-test-admin',
          Role.ADMIN,
          Object.assign(new ChallengesQueryDto(), {
            completion_status: status,
          }),
        );
        expect(result.data.map((c) => c.id)).toEqual(expected);
      }
      await expect(
        challenges.findOneForAdmin(
          'p8-test-challenge-0',
          'p8-test-admin',
          Role.ADMIN,
          Object.assign(new ChallengeAssignmentsQueryDto(), {
            client_id: 'p8-test-1',
          }),
        ),
      ).rejects.toThrow('Este cliente');
      const own = await challenges.findOneForAdmin(
        'p8-test-challenge-0',
        'p8-test-admin',
        Role.ADMIN,
        Object.assign(new ChallengeAssignmentsQueryDto(), {
          client_id: 'p8-test-0',
        }),
      );
      expect(own.assignments.total).toBe(1);
    });
  },
);
