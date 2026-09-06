import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AssignmentsService } from './assignments.service';
import type { NotificationsService } from '../notifications/notifications.service';
import { AutoAssignmentMaterializerService } from './auto-assignment-materializer.service';
import type { LastSetVideoPolicyService } from './last-set-video-policy.service';

function createAssignment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'assignment-1',
    client_id: 'client-1',
    admin_id: 'admin-1',
    date: new Date('2026-03-30T00:00:00.000Z'),
    training_id: 'training-1',
    diet_id: null,
    is_rest_day: false,
    training: {
      id: 'training-1',
      name: 'Full Body A',
      type: 'FUERZA',
      types: ['FUERZA'],
      accentColor: null,
      level: 'INTERMEDIO',
      estimated_duration_min: 45,
      estimated_calories: 320,
      is_active: true,
    },
    diet: null,
    ...overrides,
  };
}

describe('AssignmentsService', () => {
  let service: AssignmentsService;
  let prisma: {
    user: { findUnique: jest.Mock; findMany: jest.Mock };
    adminClientAssignment: { findFirst: jest.Mock };
    training: { findFirst: jest.Mock; findMany: jest.Mock };
    diet: { findFirst: jest.Mock; findMany: jest.Mock };
    planAssignment: {
      create: jest.Mock;
      createMany: jest.Mock;
      upsert: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
      deleteMany: jest.Mock;
    };
    autoAssignmentRule: {
      create: jest.Mock;
      findFirst: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
    dayProgress: {
      findUnique: jest.Mock;
      update: jest.Mock;
    };
    $transaction: jest.Mock;
    $queryRaw: jest.Mock;
  };
  let notifications: { sendInternalTemplate: jest.Mock };
  let lastSetVideoPolicy: {
    monthsForDates: jest.Mock;
    reconcile: jest.Mock;
  };

  const adminUser = {
    id: 'admin-1',
    email: 'admin@exom.dev',
    role: Role.ADMIN,
    firebase_uid: 'firebase-admin-1',
  };

  const superAdminUser = {
    id: 'super-admin-1',
    email: 'superadmin@exom.dev',
    role: Role.SUPER_ADMIN,
    firebase_uid: 'firebase-super-admin-1',
  };

  const clientUser = {
    id: 'client-1',
    email: 'client@exom.dev',
    role: Role.CLIENT,
    firebase_uid: 'firebase-client-1',
  };

  beforeAll(() => {
    jest.useFakeTimers();
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  beforeEach(() => {
    jest.setSystemTime(new Date('2026-04-01T12:00:00.000Z'));
    prisma = {
      user: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
      },
      adminClientAssignment: {
        findFirst: jest.fn(),
      },
      training: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
      },
      diet: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
      },
      planAssignment: {
        create: jest.fn(),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        upsert: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
        findUniqueOrThrow: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        deleteMany: jest.fn(),
      },
      autoAssignmentRule: {
        create: jest.fn(),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      dayProgress: {
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
      },
      $transaction: jest.fn(async (input: unknown) =>
        typeof input === 'function'
          ? (input as (tx: typeof prisma) => unknown)(prisma)
          : Promise.all(input as Promise<unknown>[]),
      ),
      $queryRaw: jest
        .fn()
        .mockImplementation((query: { sql: string }) =>
          Promise.resolve(
            query.sql.includes('diet_day_snapshots')
              ? []
              : [{ id: 'client-1' }],
          ),
        ),
    };

    notifications = {
      sendInternalTemplate: jest.fn().mockResolvedValue({
        success: true,
        sent: 0,
        failed: 0,
      }),
    };
    lastSetVideoPolicy = {
      monthsForDates: jest.fn().mockReturnValue([
        { year: 2026, month: 3 },
        { year: 2026, month: 4 },
      ]),
      reconcile: jest.fn().mockResolvedValue(undefined),
    };

    service = new AssignmentsService(
      prisma as unknown as PrismaService,
      notifications as unknown as NotificationsService,
      new AutoAssignmentMaterializerService(
        prisma as unknown as PrismaService,
        lastSetVideoPolicy as unknown as LastSetVideoPolicyService,
      ),
      lastSetVideoPolicy as unknown as LastSetVideoPolicyService,
    );
  });

  it('returns all lightweight client options for a super admin', async () => {
    prisma.user.findMany.mockResolvedValue([
      {
        id: 'client-1',
        email: 'client@exom.dev',
        profile: { first_name: 'Ana', last_name: 'Díaz', avatar_url: null },
      },
    ]);

    await expect(
      service.getClientOptions(superAdminUser),
    ).resolves.toHaveLength(1);
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { role: Role.CLIENT } }),
    );
  });

  it('limits client options to the active admin portfolio', async () => {
    prisma.user.findMany.mockResolvedValue([]);

    await service.getClientOptions(adminUser);

    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          role: Role.CLIENT,
          clientOf: { some: { admin_id: 'admin-1', is_active: true } },
        },
      }),
    );
  });

  it('returns only active lightweight assignment catalog options', async () => {
    prisma.training.findMany.mockResolvedValue([
      {
        id: 'training-1',
        name: 'Full Body',
        type: 'FUERZA',
        types: ['FUERZA'],
        accentColor: null,
        level: 'INTERMEDIO',
        estimated_duration_min: 45,
        estimated_calories: 300,
        _count: { exercises: 8 },
      },
    ]);
    prisma.diet.findMany.mockResolvedValue([
      {
        id: 'diet-1',
        name: 'Equilibrada',
        tags: ['saludable'],
        total_calories: 2100,
        total_protein_g: 140,
        total_carbs_g: 220,
        total_fat_g: 70,
        _count: { meals: 5 },
      },
    ]);

    await expect(service.getCatalogOptions()).resolves.toEqual({
      trainings: [expect.objectContaining({ id: 'training-1', exercises_count: 8 })],
      diets: [expect.objectContaining({ id: 'diet-1', meals_count: 5 })],
    });
    expect(prisma.training.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { is_active: true },
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      }),
    );
    expect(prisma.diet.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { is_active: true },
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      }),
    );
  });

  it('rejects bulk assignment when no training, diet or rest day is provided', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'client-1',
      role: Role.CLIENT,
    });
    prisma.adminClientAssignment.findFirst.mockResolvedValue({ id: 'link-1' });

    await expect(
      service.bulkAssign(adminUser, {
        client_id: 'client-1',
        dates: ['2026-03-30'],
      }),
    ).rejects.toThrow(
      new BadRequestException(
        'Debes asignar un entrenamiento, una dieta o marcar descanso',
      ),
    );

    expect(prisma.training.findFirst).not.toHaveBeenCalled();
    expect(prisma.diet.findFirst).not.toHaveBeenCalled();
    expect(prisma.planAssignment.upsert).not.toHaveBeenCalled();
  });

  it('allows a super admin to bulk-assign without admin-client relation', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'client-1', role: Role.CLIENT });
    prisma.training.findFirst.mockResolvedValue({ id: 'training-1' });
    prisma.planAssignment.upsert.mockResolvedValue(createAssignment());
    prisma.planAssignment.findMany.mockResolvedValue([createAssignment()]);

    await expect(
      service.bulkAssign(superAdminUser, {
        client_id: 'client-1',
        dates: ['2026-03-30'],
        training_id: 'training-1',
      }),
    ).resolves.toMatchObject([
      {
        id: 'assignment-1',
        client_id: 'client-1',
        date: '2026-03-30',
        is_rest_day: false,
        training: createAssignment().training,
        diet: null,
      },
    ]);

    expect(prisma.adminClientAssignment.findFirst).not.toHaveBeenCalled();
    expect(prisma.planAssignment.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          admin_id: 'super-admin-1',
          auto_assignment_rule_id: null,
        }),
        update: expect.objectContaining({
          admin_id: 'super-admin-1',
          auto_assignment_rule_id: null,
        }),
      }),
    );
    expect(notifications.sendInternalTemplate).toHaveBeenCalledWith(
      'super-admin-1',
      ['client-1'],
      'plan_training_assigned',
      { dayCount: 1, planSummary: 'un entrenamiento', date: '2026-03-30' },
      {
        title: 'Nuevo entrenamiento asignado',
        body: 'Tu entrenador asign\u00f3 un entrenamiento',
        route: '/trainings?date=2026-03-30',
      },
      { type: 'training' },
    );
  });

  it('rejects getWeek for an admin when the client is not assigned', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'client-1', role: Role.CLIENT });
    prisma.adminClientAssignment.findFirst.mockResolvedValue(null);

    await expect(
      service.getWeek(adminUser, {
        client_id: 'client-1',
        week_start: '2026-03-30',
      }),
    ).rejects.toThrow(new ForbiddenException('Este cliente no está asignado a ti'));

    expect(prisma.planAssignment.findMany).not.toHaveBeenCalled();
  });

  it('returns a normalized 7-day response for the client weekly view', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'client-1', role: Role.CLIENT });
    prisma.planAssignment.findMany.mockResolvedValue([
      createAssignment(),
      createAssignment({
        id: 'cleared-assignment',
        date: new Date('2026-03-31T00:00:00.000Z'),
        training_id: null,
        training: null,
        trainings: [],
      }),
    ]);

    const response = await service.getWeek(clientUser, {
      client_id: 'client-1',
      week_start: '2026-03-30',
    });

    expect(response.week_start).toBe('2026-03-30');
    expect(response.week_end).toBe('2026-04-05');
    expect(response.days).toHaveLength(7);
    expect(response.days[0]).toMatchObject({
      id: 'assignment-1',
      client_id: 'client-1',
      date: '2026-03-30',
      is_rest_day: false,
      training: createAssignment().training,
      diet: null,
    });
    expect(response.days[1]).toMatchObject({
      id: null,
      client_id: 'client-1',
      date: '2026-03-31',
      is_rest_day: false,
      training: null,
      diet: null,
    });
    expect(prisma.adminClientAssignment.findFirst).not.toHaveBeenCalled();
  });

  it('preserves and identifies inactive trainings in assignment history', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'client-1',
      role: Role.CLIENT,
    });
    prisma.planAssignment.findMany.mockResolvedValue([
      createAssignment({
        training_id: null,
        training: null,
        trainings: [
          {
            position: 0,
            last_set_video_policy: 'AUTO',
            requires_last_set_video: false,
            training: {
              ...createAssignment().training,
              is_active: false,
            },
          },
          {
            position: 1,
            last_set_video_policy: 'AUTO',
            requires_last_set_video: false,
            training: {
              ...createAssignment().training,
              id: 'training-2',
              name: 'Full Body B',
              is_active: false,
            },
          },
        ],
      }),
    ]);

    const response = await service.getWeek(clientUser, {
      client_id: 'client-1',
      week_start: '2026-03-30',
    });

    expect(response.days[0]).toMatchObject({
      training_ids: ['training-1', 'training-2'],
      training: { id: 'training-1', is_active: false },
      trainings: [
        { id: 'training-1', is_active: false },
        { id: 'training-2', is_active: false },
      ],
    });
  });

  it('returns a normalized monthly response for admin planning', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'client-1', role: Role.CLIENT });
    prisma.adminClientAssignment.findFirst.mockResolvedValue({ id: 'link-1' });
    prisma.planAssignment.findMany.mockResolvedValue([
      createAssignment(),
      createAssignment({
        id: 'assignment-2',
        date: new Date('2026-03-31T00:00:00.000Z'),
        training_id: null,
        diet_id: 'diet-1',
        is_rest_day: false,
        training: null,
        diet: {
          id: 'diet-1',
          name: 'Dieta Marzo',
          total_calories: 2100,
          total_protein_g: 160,
          total_carbs_g: 220,
          total_fat_g: 70,
        },
      }),
    ]);

    const response = await service.getMonth(adminUser, {
      client_id: 'client-1',
      year: 2026,
      month: 3,
    });

    expect(response.month_start).toBe('2026-03-01');
    expect(response.month_end).toBe('2026-03-31');
    expect(response.days).toHaveLength(31);
    expect(response.days[29]).toMatchObject({
      id: 'assignment-1',
      client_id: 'client-1',
      date: '2026-03-30',
      is_rest_day: false,
      training: createAssignment().training,
      diet: null,
    });
    expect(response.days[30]).toMatchObject({
      id: 'assignment-2',
      client_id: 'client-1',
      date: '2026-03-31',
      is_rest_day: false,
      training: null,
      diet: {
        id: 'diet-1',
        name: 'Dieta Marzo',
        total_calories: 2100,
        total_protein_g: 160,
        total_carbs_g: 220,
        total_fat_g: 70,
      },
    });
  });

  it('batch assigns unique days with per-day combinations', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'client-1', role: Role.CLIENT });
    prisma.adminClientAssignment.findFirst.mockResolvedValue({ id: 'link-1' });
    prisma.diet.findFirst.mockResolvedValue({ id: 'diet-1' });
    prisma.planAssignment.upsert
      .mockResolvedValueOnce(
        createAssignment({
          id: 'assignment-rest',
          date: new Date('2026-03-31T00:00:00.000Z'),
          training_id: null,
          diet_id: null,
          is_rest_day: true,
          training: null,
          diet: null,
        }),
      )
      .mockResolvedValueOnce(
        createAssignment({
          id: 'assignment-diet',
          date: new Date('2026-04-01T00:00:00.000Z'),
          training_id: null,
          diet_id: 'diet-1',
          is_rest_day: false,
          training: null,
          diet: {
            id: 'diet-1',
            name: 'Dieta Abril',
            total_calories: 1900,
            total_protein_g: 150,
            total_carbs_g: 200,
            total_fat_g: 60,
          },
        }),
      );
    prisma.planAssignment.findMany.mockResolvedValue([
      createAssignment({
        id: 'assignment-rest',
        date: new Date('2026-03-31T00:00:00.000Z'),
        training_id: null,
        diet_id: null,
        is_rest_day: true,
        training: null,
        diet: null,
      }),
      createAssignment({
        id: 'assignment-diet',
        date: new Date('2026-04-01T00:00:00.000Z'),
        training_id: null,
        diet_id: 'diet-1',
        is_rest_day: false,
        training: null,
        diet: {
          id: 'diet-1',
          name: 'Dieta Abril',
          total_calories: 1900,
          total_protein_g: 150,
          total_carbs_g: 200,
          total_fat_g: 60,
        },
      }),
    ]);

    await expect(
      service.batchAssign(adminUser, {
        client_id: 'client-1',
        days: [
          { date: '2026-04-01', diet_id: 'diet-1', is_rest_day: false },
          { date: '2026-03-31', training_id: 'training-1', is_rest_day: false },
          { date: '2026-03-31', is_rest_day: true },
        ],
      }),
    ).resolves.toMatchObject([
      {
        id: 'assignment-rest',
        client_id: 'client-1',
        date: '2026-03-31',
        is_rest_day: true,
        training: null,
        diet: null,
      },
      {
        id: 'assignment-diet',
        client_id: 'client-1',
        date: '2026-04-01',
        is_rest_day: false,
        training: null,
        diet: {
          id: 'diet-1',
          name: 'Dieta Abril',
          total_calories: 1900,
          total_protein_g: 150,
          total_carbs_g: 200,
          total_fat_g: 60,
        },
      },
    ]);

    expect(prisma.planAssignment.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.planAssignment.upsert).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        create: expect.objectContaining({
          date: new Date('2026-03-31T00:00:00.000Z'),
          auto_assignment_rule_id: null,
          training_id: null,
          diet_id: null,
          is_rest_day: true,
        }),
        update: expect.objectContaining({
          auto_assignment_rule_id: null,
        }),
      }),
    );
    expect(notifications.sendInternalTemplate).toHaveBeenCalledWith(
      'admin-1',
      ['client-1'],
      'plan_diet_assigned',
      { dayCount: 2, planSummary: '2 d\u00edas de dieta', date: '2026-04-01' },
      {
        title: 'Nueva dieta asignada',
        body: 'Tu entrenador asign\u00f3 2 d\u00edas de dieta',
        route: '/diets?date=2026-04-01',
      },
      { type: 'diet' },
    );
  });

  it('creates a weekly auto-assignment rule and deactivates the previous active rule', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'client-1', role: Role.CLIENT });
    prisma.adminClientAssignment.findFirst.mockResolvedValue({ id: 'link-1' });
    prisma.training.findFirst.mockResolvedValue({ id: 'training-1' });
    prisma.diet.findFirst.mockResolvedValue({ id: 'diet-1' });
    prisma.autoAssignmentRule.updateMany.mockResolvedValue({ count: 1 });
    prisma.autoAssignmentRule.create.mockResolvedValue({
      id: 'rule-1',
      client_id: 'client-1',
      admin_id: 'admin-1',
      source_week_start: new Date('2026-03-30T00:00:00.000Z'),
      starts_on: new Date('2026-04-06T00:00:00.000Z'),
      ends_on: null,
      is_active: true,
      deactivated_at: null,
      days: [
        {
          id: 'rule-day-1',
          weekday: 1,
          training_id: 'training-1',
          diet_id: 'diet-1',
          is_rest_day: false,
          training: createAssignment().training,
          diet: {
            id: 'diet-1',
            name: 'Dieta Abril',
            total_calories: 1900,
            total_protein_g: 150,
            total_carbs_g: 200,
            total_fat_g: 60,
          },
        },
      ],
    });

    await expect(
      service.createAutoRule(adminUser, {
        client_id: 'client-1',
        source_week_start: '2026-03-30',
        starts_on: '2026-04-06',
        days: [
          {
            weekday: 1,
            training_id: 'training-1',
            diet_id: 'diet-1',
            is_rest_day: false,
          },
        ],
      }),
    ).resolves.toMatchObject({
      id: 'rule-1',
      client_id: 'client-1',
      starts_on: '2026-04-06',
      ends_on: null,
      is_active: true,
      days: [
        {
          weekday: 1,
          training_id: 'training-1',
          diet_id: 'diet-1',
          is_rest_day: false,
        },
      ],
    });

    expect(prisma.autoAssignmentRule.updateMany).toHaveBeenCalledWith({
      where: { client_id: 'client-1', is_active: true },
      data: { is_active: false, deactivated_at: expect.any(Date) },
    });
    expect(prisma.autoAssignmentRule.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          client_id: 'client-1',
          admin_id: 'admin-1',
          starts_on: new Date('2026-04-06T00:00:00.000Z'),
        }),
      }),
    );
  });

  it('materializes active auto-assignments for an empty future week', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'client-1', role: Role.CLIENT });
    prisma.adminClientAssignment.findFirst.mockResolvedValue({ id: 'link-1' });
    prisma.autoAssignmentRule.findMany.mockResolvedValue([
      {
        id: 'rule-1',
        client_id: 'client-1',
        admin_id: 'admin-1',
        starts_on: new Date('2026-04-06T00:00:00.000Z'),
        ends_on: null,
        days: [
          {
            weekday: 1,
            training_id: 'training-1',
            diet_id: null,
            is_rest_day: false,
          },
          {
            weekday: 3,
            training_id: null,
            diet_id: null,
            is_rest_day: true,
          },
        ],
      },
    ]);
    prisma.planAssignment.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        createAssignment({
          id: 'generated-monday',
          date: new Date('2026-04-06T00:00:00.000Z'),
          auto_assignment_rule_id: 'rule-1',
        }),
      ]);
    prisma.planAssignment.createMany.mockResolvedValue({ count: 2 });

    const response = await service.getWeek(adminUser, {
      client_id: 'client-1',
      week_start: '2026-04-06',
    });

    expect(response.week_start).toBe('2026-04-06');
    expect(prisma.planAssignment.create).toHaveBeenCalledTimes(2);
    expect(prisma.planAssignment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        client_id: 'client-1',
        date: new Date('2026-04-06T00:00:00.000Z'),
        training_id: 'training-1',
        auto_assignment_rule_id: 'rule-1',
        trainings: {
          create: [
            {
              training_id: 'training-1',
              position: 0,
              last_set_video_policy: 'AUTO',
              requires_last_set_video: false,
            },
          ],
        },
      }),
    });
    expect(prisma.planAssignment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        date: new Date('2026-04-08T00:00:00.000Z'),
        training_id: null,
        diet_id: null,
        is_rest_day: true,
      }),
    });
  });

  it('reconciles already materialized weeks when an auto rule changes', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'client-1', role: Role.CLIENT });
    prisma.adminClientAssignment.findFirst.mockResolvedValue({ id: 'link-1' });
    prisma.training.findFirst.mockResolvedValue({ id: 'training-new' });
    prisma.autoAssignmentRule.findUnique.mockResolvedValue({
      id: 'rule-1',
      client_id: 'client-1',
      is_active: true,
    });
    const updatedRule = {
      id: 'rule-1',
      client_id: 'client-1',
      admin_id: 'admin-1',
      source_week_start: new Date('2026-03-30T00:00:00.000Z'),
      starts_on: new Date('2026-04-06T00:00:00.000Z'),
      ends_on: null,
      is_active: true,
      deactivated_at: null,
      created_at: new Date('2026-04-01T00:00:00.000Z'),
      days: [
        {
          id: 'rule-day-1',
          weekday: 1,
          training_id: 'training-new',
          diet_id: null,
          is_rest_day: false,
          training: createAssignment({
            training_id: 'training-new',
          }).training,
          trainings: [],
          diet: null,
        },
      ],
    };
    prisma.autoAssignmentRule.update.mockResolvedValue(updatedRule);
    prisma.autoAssignmentRule.findMany.mockResolvedValue([updatedRule]);
    prisma.planAssignment.findMany
      .mockResolvedValueOnce([
        { date: new Date('2026-04-06T00:00:00.000Z') },
      ])
      .mockResolvedValueOnce([
        {
          id: 'auto-1',
          admin_id: 'admin-1',
          date: new Date('2026-04-06T00:00:00.000Z'),
          training_id: 'training-old',
          diet_id: null,
          is_rest_day: false,
          auto_assignment_rule_id: 'rule-1',
          trainings: [],
        },
      ]);

    await service.updateAutoRule(adminUser, 'rule-1', {
      client_id: 'client-1',
      source_week_start: '2026-03-30',
      starts_on: '2026-04-06',
      days: [
        {
          weekday: 1,
          training_id: 'training-new',
          is_rest_day: false,
        },
      ],
    });

    expect(prisma.planAssignment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'auto-1' },
        data: expect.objectContaining({
          training_id: 'training-new',
          auto_assignment_rule_id: 'rule-1',
        }),
      }),
    );
  });

  it('does not overwrite existing assignments when materializing an auto rule', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'client-1', role: Role.CLIENT });
    prisma.adminClientAssignment.findFirst.mockResolvedValue({ id: 'link-1' });
    prisma.autoAssignmentRule.findMany.mockResolvedValue([
      {
        id: 'rule-1',
        client_id: 'client-1',
        admin_id: 'admin-1',
        starts_on: new Date('2026-04-06T00:00:00.000Z'),
        ends_on: null,
        days: [
          {
            weekday: 1,
            training_id: 'training-auto',
            diet_id: null,
            is_rest_day: false,
          },
        ],
      },
    ]);
    prisma.planAssignment.findMany
      .mockResolvedValueOnce([{
        date: new Date('2026-04-06T00:00:00.000Z'),
          auto_assignment_rule_id: null,
        },
      ])
      .mockResolvedValueOnce([
        createAssignment({
          id: 'manual-monday',
          date: new Date('2026-04-06T00:00:00.000Z'),
          training_id: 'training-manual',
        }),
      ]);

    await service.getWeek(adminUser, {
      client_id: 'client-1',
      week_start: '2026-04-06',
    });

    expect(prisma.planAssignment.create).not.toHaveBeenCalled();
  });

  it('does not materialize inactive rules after deactivation', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'client-1', role: Role.CLIENT });
    prisma.adminClientAssignment.findFirst.mockResolvedValue({ id: 'link-1' });
    prisma.autoAssignmentRule.findUnique.mockResolvedValue({
      id: 'rule-1',
      client_id: 'client-1',
      is_active: true,
    });
    prisma.autoAssignmentRule.update.mockResolvedValue({
      id: 'rule-1',
      client_id: 'client-1',
      admin_id: 'admin-1',
      source_week_start: new Date('2026-03-30T00:00:00.000Z'),
      starts_on: new Date('2026-04-06T00:00:00.000Z'),
      ends_on: null,
      is_active: false,
      deactivated_at: new Date('2026-04-01T00:00:00.000Z'),
      days: [],
    });
    prisma.planAssignment.findMany
      .mockResolvedValueOnce([
        { date: new Date('2026-04-06T00:00:00.000Z') },
      ])
      .mockResolvedValueOnce([
        {
          id: 'auto-1',
          admin_id: 'admin-1',
          date: new Date('2026-04-06T00:00:00.000Z'),
          training_id: 'training-1',
          diet_id: null,
          is_rest_day: false,
          auto_assignment_rule_id: 'rule-1',
          trainings: [],
        },
      ]);

    await expect(service.deactivateAutoRule(adminUser, 'rule-1')).resolves.toMatchObject({
      id: 'rule-1',
      is_active: false,
    });
    expect(prisma.planAssignment.delete).toHaveBeenCalledWith({
      where: { id: 'auto-1' },
    });

    prisma.autoAssignmentRule.findMany.mockResolvedValue([]);
    prisma.planAssignment.findMany.mockResolvedValue([]);

    await service.getWeek(adminUser, {
      client_id: 'client-1',
      week_start: '2026-04-06',
    });

    expect(prisma.planAssignment.create).not.toHaveBeenCalled();
  });

  it('rejects copyWeek when source and target weeks are the same', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'client-1', role: Role.CLIENT });
    prisma.adminClientAssignment.findFirst.mockResolvedValue({ id: 'link-1' });

    await expect(
      service.copyWeek(adminUser, {
        client_id: 'client-1',
        source_week_start: '2026-03-30',
        target_week_start: '2026-03-30',
      }),
    ).rejects.toThrow(
      new BadRequestException('La semana de origen y destino no puede ser la misma'),
    );

    expect(prisma.planAssignment.findMany).not.toHaveBeenCalled();
  });

  it('copies a discontinuous selection and clears targets for empty source days', async () => {
    prisma.training.findFirst.mockResolvedValue({ id: 'training-1' });
    prisma.user.findUnique.mockResolvedValue({
      id: 'client-1',
      role: Role.CLIENT,
    });
    prisma.adminClientAssignment.findFirst.mockResolvedValue({ id: 'link-1' });
    prisma.planAssignment.findMany.mockResolvedValue([
      createAssignment({ date: new Date('2026-03-30T00:00:00.000Z') }),
      createAssignment({
        id: 'cleared-source',
        date: new Date('2026-04-01T00:00:00.000Z'),
        training_id: null,
        training: null,
        trainings: [],
      }),
    ]);
    prisma.planAssignment.upsert.mockResolvedValue({});

    await expect(
      service.copySelection(adminUser, {
      client_id: 'client-1',
      source_dates: ['2026-04-01', '2026-03-30', '2026-04-01'],
      target_start_date: '2026-04-06',
      }),
    ).resolves.toEqual({
      copied_count: 1,
      cleared_count: 1,
      target_dates: ['2026-04-06', '2026-04-08'],
    });
    expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.planAssignment.findMany.mock.invocationCallOrder[0],
    );
    expect(prisma.planAssignment.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          client_id_date: {
            client_id: 'client-1',
            date: new Date('2026-04-06T00:00:00.000Z'),
          },
        },
      }),
    );
    expect(prisma.planAssignment.upsert).toHaveBeenCalledWith({
      where: {
        client_id_date: {
          client_id: 'client-1',
          date: new Date('2026-04-08T00:00:00.000Z'),
        },
      },
      create: {
        client_id: 'client-1',
        admin_id: 'admin-1',
        auto_assignment_rule_id: null,
        date: new Date('2026-04-08T00:00:00.000Z'),
        training_id: null,
        diet_id: null,
        is_rest_day: false,
        notes: null,
      },
      update: {
        admin_id: 'admin-1',
        auto_assignment_rule_id: null,
        training_id: null,
        diet_id: null,
        is_rest_day: false,
        notes: null,
        trainings: { deleteMany: {} },
      },
    });
    expect(prisma.planAssignment.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          auto_assignment_rule_id: null,
          trainings: {
            create: [
              {
                training_id: 'training-1',
                position: 0,
                last_set_video_policy: 'AUTO',
                requires_last_set_video: false,
              },
            ],
          },
        }),
        update: expect.objectContaining({
          auto_assignment_rule_id: null,
        }),
      }),
    );
  });

  it('never rewrites completed progress after an assignment change', async () => {
    const date = new Date('2026-04-08T00:00:00.000Z');
    prisma.planAssignment.findUnique.mockResolvedValue(
      createAssignment({
        date,
        trainings: [
          {
            position: 0,
            training: {
              id: 'training-new',
              exercises: [
                { id: 'training-exercise-new', exercise_id: 'exercise-new' },
              ],
            },
          },
        ],
      }),
    );
    prisma.dayProgress.findUnique.mockResolvedValue({
      id: 'progress-1',
      training_completed: true,
      trainings_completed: ['training-old'],
      exercises_completed: [
        {
          training_exercise_id: 'training-exercise-old',
          exercise_id: 'exercise-old',
          completed: true,
        },
      ],
    });

    await (
      service as unknown as {
        reconcileProgressForDate(clientId: string, date: Date): Promise<void>;
      }
    ).reconcileProgressForDate('client-1', date);

    expect(prisma.dayProgress.update).not.toHaveBeenCalled();
  });

  it('copyWeek notifies with the first active copied target date', async () => {
    prisma.training.findFirst.mockResolvedValue({ id: 'training-1' });
    prisma.user.findUnique.mockResolvedValue({ id: 'client-1', role: Role.CLIENT });
    prisma.adminClientAssignment.findFirst.mockResolvedValue({ id: 'link-1' });
    prisma.planAssignment.findMany.mockResolvedValue([
      createAssignment({
        id: 'assignment-source-wed',
        date: new Date('2026-04-01T00:00:00.000Z'),
      }),
    ]);
    prisma.planAssignment.upsert.mockResolvedValue(
      createAssignment({
        id: 'assignment-target-wed',
        date: new Date('2026-04-08T00:00:00.000Z'),
      }),
    );
    const getWeekSpy = jest.spyOn(service, 'getWeek').mockResolvedValue({
      client_id: 'client-1',
      week_start: '2026-04-06',
      week_end: '2026-04-12',
      days: [],
    });

    await expect(
      service.copyWeek(adminUser, {
        client_id: 'client-1',
        source_week_start: '2026-03-30',
        target_week_start: '2026-04-06',
      }),
    ).resolves.toEqual({
      client_id: 'client-1',
      week_start: '2026-04-06',
      week_end: '2026-04-12',
      days: [],
    });

    expect(notifications.sendInternalTemplate).toHaveBeenCalledWith(
      'admin-1',
      ['client-1'],
      'plan_training_assigned',
      { dayCount: 1, planSummary: 'un entrenamiento', date: '2026-04-08' },
      {
        title: 'Nuevo entrenamiento asignado',
        body: 'Tu entrenador asignó un entrenamiento',
        route: '/trainings?date=2026-04-08',
      },
      { type: 'training' },
    );
    expect(prisma.planAssignment.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ auto_assignment_rule_id: null }),
        update: expect.objectContaining({ auto_assignment_rule_id: null }),
      }),
    );
    expect(prisma.planAssignment.upsert).toHaveBeenCalledTimes(7);
    expect(prisma.planAssignment.upsert).toHaveBeenCalledWith({
      where: {
        client_id_date: {
          client_id: 'client-1',
          date: new Date('2026-04-06T00:00:00.000Z'),
        },
      },
      create: {
        client_id: 'client-1',
        admin_id: 'admin-1',
        auto_assignment_rule_id: null,
        date: new Date('2026-04-06T00:00:00.000Z'),
        training_id: null,
        diet_id: null,
        is_rest_day: false,
        notes: null,
      },
      update: {
        admin_id: 'admin-1',
        auto_assignment_rule_id: null,
        training_id: null,
        diet_id: null,
        is_rest_day: false,
        notes: null,
        trainings: { deleteMany: {} },
      },
    });

    getWeekSpy.mockRestore();
  });

  it.each(['week', 'selection'])(
    'rejects a new %s copy of retired catalog resources',
    async (kind) => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'client-1',
        role: Role.CLIENT,
      });
      prisma.adminClientAssignment.findFirst.mockResolvedValue({
        id: 'link-1',
      });
      prisma.planAssignment.findMany.mockResolvedValue([createAssignment()]);
      prisma.training.findFirst.mockResolvedValue(null);
      const request =
        kind === 'week'
          ? service.copyWeek(adminUser, {
              client_id: 'client-1',
              source_week_start: '2026-03-30',
              target_week_start: '2026-04-06',
            })
          : service.copySelection(adminUser, {
              client_id: 'client-1',
              source_dates: ['2026-03-30'],
              target_start_date: '2026-04-06',
            });
      await expect(request).rejects.toThrow('Entrenamiento no encontrado');
      expect(prisma.planAssignment.upsert).not.toHaveBeenCalled();
    },
  );

  it('rejects update when moving an assignment to a date already occupied', async () => {
    prisma.planAssignment.findUnique
      .mockResolvedValueOnce(createAssignment())
      .mockResolvedValueOnce(createAssignment())
      .mockResolvedValueOnce({ id: 'assignment-2' });
    prisma.user.findUnique.mockResolvedValue({
      id: 'client-1',
      role: Role.CLIENT,
    });
    prisma.adminClientAssignment.findFirst.mockResolvedValue({ id: 'link-1' });

    await expect(
      service.updateAssignment(adminUser, 'assignment-1', {
        date: '2026-03-31',
        training_id: 'training-1',
      }),
    ).rejects.toThrow(
      new ConflictException(
        'Ya existe una asignación para ese cliente en la fecha indicada',
      ),
    );

    expect(prisma.planAssignment.update).not.toHaveBeenCalled();
  });

  it('leaves an empty manual override on the source of a moved assignment', async () => {
    const source = createAssignment({ auto_assignment_rule_id: 'rule-1' });
    prisma.planAssignment.findUnique
      .mockResolvedValueOnce(source)
      .mockResolvedValueOnce(source)
      .mockResolvedValueOnce(null);
    prisma.user.findUnique.mockResolvedValue({ id: 'client-1', role: Role.CLIENT });
    prisma.adminClientAssignment.findFirst.mockResolvedValue({ id: 'link-1' });
    prisma.training.findFirst.mockResolvedValue({ id: 'training-1' });
    prisma.planAssignment.findUniqueOrThrow.mockResolvedValue(source);
    await service.updateAssignment(adminUser, 'assignment-1', {
      date: '2026-04-07',
    });
    expect(prisma.planAssignment.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          client_id_date: {
            client_id: 'client-1',
            date: new Date('2026-03-30T00:00:00.000Z'),
          },
        },
        create: {
          client_id: 'client-1',
          admin_id: 'admin-1',
          date: new Date('2026-03-30T00:00:00.000Z'),
          auto_assignment_rule_id: null,
          training_id: null,
          diet_id: null,
          is_rest_day: false,
          notes: null,
        },
      }),
    );
  });

  it('turns a direct update of an automatic assignment into a manual override', async () => {
    prisma.planAssignment.findUnique.mockResolvedValue(
      createAssignment({
        auto_assignment_rule_id: 'rule-1',
        trainings: [],
      }),
    );
    prisma.user.findUnique.mockResolvedValue({
      id: 'client-1',
      role: Role.CLIENT,
    });
    prisma.adminClientAssignment.findFirst.mockResolvedValue({ id: 'link-1' });
    prisma.training.findFirst.mockResolvedValue({ id: 'training-2' });
    prisma.planAssignment.findUniqueOrThrow.mockResolvedValue(
      createAssignment({
        training_id: 'training-2',
      }),
    );

    await service.updateAssignment(adminUser, 'assignment-1', {
      training_id: 'training-2',
      is_rest_day: false,
    });

    expect(prisma.planAssignment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'assignment-1' },
        data: expect.objectContaining({
          auto_assignment_rule_id: null,
          training_id: 'training-2',
        }),
      }),
    );
  });

  it('re-reads an assignment after locking before applying a partial update', async () => {
    const initial = createAssignment();
    const latest = createAssignment({
      training_id: 'training-latest',
      training: {
        ...createAssignment().training,
        id: 'training-latest',
        name: 'Latest training',
      },
    });
    prisma.planAssignment.findUnique
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(latest);
    prisma.user.findUnique.mockResolvedValue({
      id: 'client-1',
      role: Role.CLIENT,
    });
    prisma.adminClientAssignment.findFirst.mockResolvedValue({ id: 'link-1' });
    prisma.training.findFirst.mockResolvedValue({ id: 'training-latest' });
    prisma.planAssignment.findUniqueOrThrow.mockResolvedValue(latest);

    await service.updateAssignment(adminUser, 'assignment-1', {
      is_rest_day: false,
    });

    expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.planAssignment.findUnique.mock.invocationCallOrder[1],
    );
    expect(prisma.planAssignment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          training_id: 'training-latest',
          auto_assignment_rule_id: null,
        }),
      }),
    );
  });

  it('deletes a single assignment day after validating access', async () => {
    const initialDate = new Date('2026-03-30T00:00:00.000Z');
    const lockedDate = new Date('2026-04-01T00:00:00.000Z');
    prisma.planAssignment.findUnique
      .mockResolvedValueOnce({
        id: 'assignment-1',
        client_id: 'client-1',
        date: initialDate,
      })
      .mockResolvedValueOnce({
      id: 'assignment-1',
      client_id: 'client-1',
        date: lockedDate,
      });
    prisma.user.findUnique.mockResolvedValue({
      id: 'client-1',
      role: Role.CLIENT,
    });
    prisma.adminClientAssignment.findFirst.mockResolvedValue({ id: 'link-1' });
    prisma.planAssignment.upsert.mockResolvedValue({});

    await expect(
      service.deleteAssignment(adminUser, 'assignment-1'),
    ).resolves.toEqual({
      message: 'Asignación eliminada exitosamente',
    });

    expect(prisma.planAssignment.upsert).toHaveBeenCalledWith({
      where: {
        client_id_date: {
          client_id: 'client-1',
          date: lockedDate,
        },
      },
      create: {
        client_id: 'client-1',
        admin_id: 'admin-1',
        auto_assignment_rule_id: null,
        date: lockedDate,
        training_id: null,
        diet_id: null,
        is_rest_day: false,
        notes: null,
      },
      update: {
        admin_id: 'admin-1',
        auto_assignment_rule_id: null,
        training_id: null,
        diet_id: null,
        is_rest_day: false,
        notes: null,
        trainings: { deleteMany: {} },
      },
    });
    expect(lastSetVideoPolicy.monthsForDates).toHaveBeenCalledWith([
      lockedDate,
    ]);
  });

  it('keeps deletion idempotent when the same assignment id is retried', async () => {
    const date = new Date('2026-04-01T00:00:00.000Z');
    prisma.planAssignment.findUnique.mockResolvedValue({
      id: 'assignment-1',
      client_id: 'client-1',
      date,
    });
    prisma.user.findUnique.mockResolvedValue({
      id: 'client-1',
      role: Role.CLIENT,
    });
    prisma.adminClientAssignment.findFirst.mockResolvedValue({ id: 'link-1' });
    prisma.planAssignment.upsert.mockResolvedValue({});

    await service.deleteAssignment(adminUser, 'assignment-1');
    await service.deleteAssignment(adminUser, 'assignment-1');

    expect(prisma.planAssignment.upsert).toHaveBeenCalledTimes(2);
    const expectedWrite = {
      where: { client_id_date: { client_id: 'client-1', date } },
      create: {
        client_id: 'client-1',
        admin_id: 'admin-1',
        auto_assignment_rule_id: null,
        date,
        training_id: null,
        diet_id: null,
        is_rest_day: false,
        notes: null,
      },
      update: {
        admin_id: 'admin-1',
        auto_assignment_rule_id: null,
        training_id: null,
        diet_id: null,
        is_rest_day: false,
        notes: null,
        trainings: { deleteMany: {} },
      },
    };
    expect(prisma.planAssignment.upsert).toHaveBeenNthCalledWith(
      1,
      expectedWrite,
    );
    expect(prisma.planAssignment.upsert).toHaveBeenNthCalledWith(
      2,
      expectedWrite,
    );
  });

  it('deletes multiple assignment days after validating every client', async () => {
    const firstDate = new Date('2026-04-08T00:00:00.000Z');
    const secondDate = new Date('2026-04-09T00:00:00.000Z');
    prisma.planAssignment.findMany.mockResolvedValue([
      { id: 'assignment-1', client_id: 'client-1', date: firstDate },
      { id: 'assignment-2', client_id: 'client-1', date: secondDate },
    ]);
    prisma.user.findUnique.mockResolvedValue({ id: 'client-1', role: Role.CLIENT });
    prisma.adminClientAssignment.findFirst.mockResolvedValue({ id: 'link-1' });
    prisma.planAssignment.upsert.mockResolvedValue({});

    await expect(
      service.deleteAssignments(adminUser, ['assignment-1', 'assignment-2']),
    ).resolves.toEqual({ deleted_count: 2 });

    expect(prisma.planAssignment.upsert).toHaveBeenCalledTimes(2);
    const clearedAssignment = (date: Date) => ({
      where: {
        client_id_date: { client_id: 'client-1', date },
      },
      create: {
        client_id: 'client-1',
        admin_id: 'admin-1',
        auto_assignment_rule_id: null,
        date,
        training_id: null,
        diet_id: null,
        is_rest_day: false,
        notes: null,
      },
      update: {
        admin_id: 'admin-1',
        auto_assignment_rule_id: null,
        training_id: null,
        diet_id: null,
        is_rest_day: false,
        notes: null,
        trainings: { deleteMany: {} },
      },
    });
    expect(prisma.planAssignment.upsert).toHaveBeenNthCalledWith(
      1,
      clearedAssignment(firstDate),
    );
    expect(prisma.planAssignment.upsert).toHaveBeenNthCalledWith(
      2,
      clearedAssignment(secondDate),
    );
  });

  it('does not delete when one selected assignment does not exist', async () => {
    prisma.planAssignment.findMany.mockResolvedValue([
      { id: 'assignment-1', client_id: 'client-1' },
    ]);

    await expect(
      service.deleteAssignments(adminUser, ['assignment-1', 'missing-assignment']),
    ).rejects.toThrow('Una o varias asignaciones no existen');

    expect(prisma.planAssignment.upsert).not.toHaveBeenCalled();
  });

  it('persists up to five training ids in the requested order', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'client-1', role: Role.CLIENT });
    prisma.adminClientAssignment.findFirst.mockResolvedValue({ id: 'link-1' });
    prisma.training.findFirst.mockImplementation(({ where }) =>
      Promise.resolve({ id: where.id }),
    );
    prisma.planAssignment.upsert.mockResolvedValue(createAssignment({
      trainings: [
        { position: 0, training: createAssignment().training },
      ],
    }));
    prisma.planAssignment.findMany.mockResolvedValue([createAssignment()]);

    await service.bulkAssign(adminUser, {
      client_id: 'client-1',
      dates: ['2026-08-04'],
      training_ids: ['training-2', 'training-1'],
      is_rest_day: false,
    });

    expect(prisma.planAssignment.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          auto_assignment_rule_id: null,
          training_id: 'training-2',
          trainings: {
            create: [
              {
                training_id: 'training-2',
                position: 0,
                last_set_video_policy: 'AUTO',
                requires_last_set_video: false,
              },
              {
                training_id: 'training-1',
                position: 1,
                last_set_video_policy: 'AUTO',
                requires_last_set_video: false,
              },
            ],
          },
        }),
      }),
    );
  });

  it('rejects duplicate and more than five trainings defensively', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'client-1',
      role: Role.CLIENT,
    });
    prisma.adminClientAssignment.findFirst.mockResolvedValue({ id: 'link-1' });

    await expect(service.bulkAssign(adminUser, {
      client_id: 'client-1',
      dates: ['2026-08-04'],
      training_ids: ['training-1', 'training-1'],
      is_rest_day: false,
    })).rejects.toThrow('No puedes repetir un entrenamiento');

    await expect(
      service.bulkAssign(adminUser, {
        client_id: 'client-1',
        dates: ['2026-08-04'],
        training_ids: ['1', '2', '3', '4', '5', '6'],
        is_rest_day: false,
      }),
    ).rejects.toThrow('No puedes asignar más de 5 entrenamientos');
  });
});
