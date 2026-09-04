import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { UsersService } from './users.service';
import { UpdateClientAssignmentsDto } from './dto/update-client-assignments.dto';
import { ChallengesService } from '../challenges/challenges.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { MetricsService } from '../metrics/metrics.service';
import type { CalendarService } from '../calendar/calendar.service';

const createUserMock = jest.fn();

jest.mock('firebase-admin', () => ({
  auth: () => ({
    createUser: createUserMock,
  }),
}));

describe('UsersService', () => {
  let service: UsersService;
  let prisma: {
    $transaction: jest.Mock;
    user: {
      findUnique: jest.Mock;
      findFirst: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
    adminClientAssignment: {
      findFirst: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      create: jest.Mock;
      updateMany: jest.Mock;
      createMany: jest.Mock;
    };
    dayProgress: {
      findFirst: jest.Mock;
      update: jest.Mock;
    };
    exercise: {
      findMany: jest.Mock;
    };
    meal: {
      findMany: jest.Mock;
    };
  };
  let challengesService: {
    syncGlobalChallengesForCreatorClient: jest.Mock;
  };
  let notifications: {
    sendInternalTemplate: jest.Mock;
    sendToUser: jest.Mock;
  };
  let metricsService: {
    createForClient: jest.Mock;
    updateForClient: jest.Mock;
  };
  let calendarService: {
    getMonthCalendar: jest.Mock;
    getWeekSummary: jest.Mock;
  };

  beforeEach(() => {
    createUserMock.mockReset();
    prisma = {
      $transaction: jest.fn(async (callback: any) => callback(prisma)),
      user: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      adminClientAssignment: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
        updateMany: jest.fn(),
        createMany: jest.fn(),
      },
      dayProgress: {
        findFirst: jest.fn(),
        update: jest.fn(),
      },
      exercise: {
        findMany: jest.fn(),
      },
      meal: {
        findMany: jest.fn(),
      },
    };

    challengesService = {
      syncGlobalChallengesForCreatorClient: jest
        .fn()
        .mockResolvedValue(undefined),
    };
    notifications = {
      sendInternalTemplate: jest.fn().mockResolvedValue({
        success: true,
        sent: 1,
        failed: 0,
      }),
      sendToUser: jest.fn().mockResolvedValue({ success: true }),
    };
    metricsService = {
      createForClient: jest.fn(),
      updateForClient: jest.fn(),
    };
    calendarService = {
      getMonthCalendar: jest.fn(),
      getWeekSummary: jest.fn(),
    };

    service = new UsersService(
      prisma as unknown as PrismaService,
      challengesService as unknown as ChallengesService,
      notifications as unknown as NotificationsService,
      metricsService as unknown as MetricsService,
      calendarService as unknown as CalendarService,
    );
  });

  it('keeps creator auto-assignment when creating a client', async () => {
    const dto = {
      email: 'client-1@exom.dev',
      password: 'super-secret',
      first_name: 'Ada',
      last_name: 'Rivera',
      level: 'INTERMEDIO' as const,
      main_goal: 'Ganar fuerza',
    };
    const createdAt = new Date('2024-03-01T10:00:00.000Z');

    prisma.user.findUnique.mockResolvedValue(null);
    createUserMock.mockResolvedValue({ uid: 'firebase-client-1' });
    prisma.user.create.mockResolvedValue({
      id: 'client-1',
      email: dto.email,
      role: Role.CLIENT,
      is_active: true,
      is_locked: false,
      created_at: createdAt,
      profile: {
        first_name: dto.first_name,
        last_name: dto.last_name,
        level: dto.level,
        main_goal: dto.main_goal,
      },
    });
    prisma.adminClientAssignment.create.mockResolvedValue({
      id: 'assignment-1',
      admin_id: 'admin-1',
      client_id: 'client-1',
      is_active: true,
    });

    await expect(
      service.createClient('admin-1', Role.ADMIN, dto),
    ).resolves.toEqual({
      id: 'client-1',
      email: dto.email,
      role: Role.CLIENT,
      is_active: true,
      is_locked: false,
      created_at: createdAt,
      profile: {
        first_name: dto.first_name,
        last_name: dto.last_name,
        level: dto.level,
        main_goal: dto.main_goal,
      },
    });

    expect(createUserMock).toHaveBeenCalledWith({
      email: dto.email,
      password: dto.password,
      displayName: `${dto.first_name} ${dto.last_name}`,
    });
    expect(prisma.user.create).toHaveBeenCalledWith({
      data: {
        email: dto.email,
        firebase_uid: 'firebase-client-1',
        role: Role.CLIENT,
        auth_provider: 'email',
        profile: {
          create: {
            first_name: dto.first_name,
            last_name: dto.last_name,
            level: dto.level,
            main_goal: dto.main_goal,
          },
        },
      },
      include: { profile: true },
    });
    expect(prisma.adminClientAssignment.create).toHaveBeenCalledWith({
      data: { admin_id: 'admin-1', client_id: 'client-1' },
    });
    expect(notifications.sendInternalTemplate).toHaveBeenCalledWith(
      'admin-1',
      ['admin-1'],
      'admin_client_assigned',
      { clientName: 'Ada Rivera', clientId: 'client-1' },
      {
        title: 'Cliente asignado',
        body: 'Ada Rivera te ha sido asignado',
        route: '/admin/clients/client-1',
      },
      {
        type: 'client_assigned',
        client_id: 'client-1',
      },
    );
  });

  it('enriches daily progress with exercise and meal names while preserving identifiers', async () => {
    const progress = {
      id: 'progress-1',
      client_id: 'client-1',
      date: new Date('2026-06-29T00:00:00.000Z'),
      training_completed: true,
      exercises_completed: [
        { exercise_id: 'ex-plank', completed_at: '2026-06-29T10:00:00.000Z' },
        {
          exercise_id: 'missing-exercise',
          completed_at: '2026-06-29T10:05:00.000Z',
        },
      ],
      meals_completed: ['meal-1', 'missing-meal'],
      notes: null,
    };
    prisma.dayProgress.findFirst.mockResolvedValue(progress);
    prisma.exercise.findMany.mockResolvedValue([
      { id: 'ex-plank', name: 'Plancha isométrica' },
    ]);
    prisma.meal.findMany.mockResolvedValue([
      { id: 'meal-1', name: 'Desayuno' },
    ]);

    await expect(
      service.getClientDayProgress(
        'super-admin-1',
        Role.SUPER_ADMIN,
        'client-1',
        '2026-06-29',
      ),
    ).resolves.toEqual({
      ...progress,
      exercises_completed: [
        {
          exercise_id: 'ex-plank',
          completed_at: '2026-06-29T10:00:00.000Z',
          exercise_name: 'Plancha isométrica',
        },
        {
          exercise_id: 'missing-exercise',
          completed_at: '2026-06-29T10:05:00.000Z',
          exercise_name: null,
        },
      ],
      meals_completed_details: [
        { meal_id: 'meal-1', meal_name: 'Desayuno' },
        { meal_id: 'missing-meal', meal_name: null },
      ],
    });

    expect(prisma.exercise.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['ex-plank', 'missing-exercise'] } },
      select: { id: true, name: true },
    });
    expect(prisma.meal.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['meal-1', 'missing-meal'] } },
      select: { id: true, name: true },
    });
  });

  it('stores a training note reply and notifies the client', async () => {
    const progress = {
      id: 'progress-1',
      client_id: 'client-1',
      date: new Date('2026-06-29T00:00:00.000Z'),
      notes: 'Me molestó la rodilla',
      admin_reply_text: null,
      admin_reply_sent_at: null,
      trainings_completed: ['training-1'],
    };
    const updated = {
      ...progress,
      admin_reply_text: 'Baja el peso y avísame si continúa.',
      admin_reply_sent_at: new Date(),
    };
    prisma.dayProgress.findFirst.mockResolvedValue(progress);
    prisma.dayProgress.update.mockResolvedValue(updated);

    await expect(
      service.replyToTrainingNote(
        'super-admin-1',
        Role.SUPER_ADMIN,
        'client-1',
        '2026-06-29',
        '  Baja el peso y avísame si continúa.  ',
      ),
    ).resolves.toEqual(updated);

    expect(prisma.dayProgress.update).toHaveBeenCalledWith({
      where: { id: 'progress-1' },
      data: {
        admin_reply_text: 'Baja el peso y avísame si continúa.',
        admin_reply_sent_at: expect.any(Date),
      },
    });
    expect(notifications.sendToUser).toHaveBeenCalledWith(
      'super-admin-1',
      'client-1',
      'Tu entrenador ha respondido a tu nota',
      'Abre el entreno para leer su respuesta.',
      {
        type: 'training_note_reply',
        route: '/trainings/training-1?date=2026-06-29',
      },
    );
  });

  it('does not update or notify when the training note reply is unchanged', async () => {
    const progress = {
      id: 'progress-1',
      notes: 'Nota',
      admin_reply_text: 'Respuesta actual',
      trainings_completed: ['training-1'],
    };
    prisma.dayProgress.findFirst.mockResolvedValue(progress);

    await expect(
      service.replyToTrainingNote(
        'super-admin-1',
        Role.SUPER_ADMIN,
        'client-1',
        '2026-06-29',
        ' Respuesta actual ',
      ),
    ).resolves.toEqual(progress);

    expect(prisma.dayProgress.update).not.toHaveBeenCalled();
    expect(notifications.sendToUser).not.toHaveBeenCalled();
  });

  it('clears a training note reply without notifying the client', async () => {
    prisma.dayProgress.findFirst.mockResolvedValue({
      id: 'progress-1',
      notes: 'Nota',
      admin_reply_text: 'Respuesta actual',
      trainings_completed: [],
    });
    prisma.dayProgress.update.mockResolvedValue({
      id: 'progress-1',
      admin_reply_text: null,
      admin_reply_sent_at: null,
    });

    await service.replyToTrainingNote(
      'super-admin-1',
      Role.SUPER_ADMIN,
      'client-1',
      '2026-06-29',
      '   ',
    );

    expect(prisma.dayProgress.update).toHaveBeenCalledWith({
      where: { id: 'progress-1' },
      data: { admin_reply_text: null, admin_reply_sent_at: null },
    });
    expect(notifications.sendToUser).not.toHaveBeenCalled();
  });

  it('rejects a reply when the daily progress has no client note', async () => {
    prisma.dayProgress.findFirst.mockResolvedValue({
      id: 'progress-1',
      notes: null,
      admin_reply_text: null,
      trainings_completed: [],
    });

    await expect(
      service.replyToTrainingNote(
        'super-admin-1',
        Role.SUPER_ADMIN,
        'client-1',
        '2026-06-29',
        'Respuesta',
      ),
    ).rejects.toThrow(
      new BadRequestException('El progreso no contiene una nota del cliente'),
    );
  });

  it('allows a super admin to view a client profile without assignment', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'client-1',
      role: Role.CLIENT,
      profile: null,
      bodyMetrics: [],
      streak: null,
    });

    await expect(
      service.getClientProfile('super-admin-1', Role.SUPER_ADMIN, 'client-1'),
    ).resolves.toEqual({
      id: 'client-1',
      role: Role.CLIENT,
      profile: null,
      bodyMetrics: [],
      streak: null,
    });

    expect(prisma.adminClientAssignment.findFirst).not.toHaveBeenCalled();
  });

  it('rejects an admin when the client is not assigned', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'client-1',
      role: Role.CLIENT,
      profile: null,
      bodyMetrics: [],
      streak: null,
    });
    prisma.adminClientAssignment.findFirst.mockResolvedValue(null);

    await expect(
      service.getClientProfile('admin-1', Role.ADMIN, 'client-1'),
    ).rejects.toThrow(
      new ForbiddenException('Este cliente no está asignado a ti'),
    );

    expect(prisma.adminClientAssignment.findFirst).toHaveBeenCalledWith({
      where: { admin_id: 'admin-1', client_id: 'client-1', is_active: true },
    });
  });

  it('returns not found before validating assignment when the client does not exist', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(
      service.getClientProfile('admin-1', Role.ADMIN, 'missing-client'),
    ).rejects.toThrow(new NotFoundException('Cliente no encontrado'));

    expect(prisma.adminClientAssignment.findFirst).not.toHaveBeenCalled();
  });

  it('returns not found when the requested profile belongs to a non-client user', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'admin-2',
      role: Role.ADMIN,
      profile: null,
      bodyMetrics: [],
      streak: null,
    });

    await expect(
      service.getClientProfile('super-admin-1', Role.SUPER_ADMIN, 'admin-2'),
    ).rejects.toThrow(new NotFoundException('Cliente no encontrado'));

    expect(prisma.adminClientAssignment.findFirst).not.toHaveBeenCalled();
  });

  it('updates all editable client profile fields', async () => {
    const birthDate = new Date('1992-04-15T00:00:00.000Z');
    prisma.user.findUnique
      .mockResolvedValueOnce({
        id: 'client-1',
        role: Role.CLIENT,
        profile: { id: 'profile-1' },
      })
      .mockResolvedValueOnce({
        id: 'client-1',
        role: Role.CLIENT,
        profile: { first_name: 'Ada', last_name: 'Rivera' },
        bodyMetrics: [],
        streak: null,
      });
    prisma.user.update.mockResolvedValue({});

    await service.updateClientProfile(
      'super-admin-1',
      Role.SUPER_ADMIN,
      'client-1',
      {
        first_name: ' Ada ',
        last_name: ' Rivera ',
        level: 'AVANZADO',
        main_goal: ' Ganar fuerza ',
        muscle_mass_goal: 30.5,
        target_calories: 2400,
        current_weight: 72.4,
        height: 178,
        birth_date: birthDate,
      },
    );

    const expectedProfile = {
      first_name: 'Ada',
      last_name: 'Rivera',
      level: 'AVANZADO',
      main_goal: 'Ganar fuerza',
      muscle_mass_goal: 30.5,
      target_calories: 2400,
      current_weight: 72.4,
      height: 178,
      birth_date: birthDate,
    };
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'client-1' },
      data: {
        profile: {
          upsert: {
            create: expectedProfile,
            update: expectedProfile,
          },
        },
      },
    });
  });

  it('lets a super admin create metrics for any client', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'client-1',
      role: Role.CLIENT,
    });
    metricsService.createForClient.mockResolvedValue({ id: 'metric-1' });

    await expect(
      service.createClientMetric(
        'super-admin-1',
        Role.SUPER_ADMIN,
        'client-1',
        {
          date: '2026-07-10',
          weight_kg: 72,
        },
      ),
    ).resolves.toEqual({ id: 'metric-1' });

    expect(metricsService.createForClient).toHaveBeenCalledWith('client-1', {
      date: '2026-07-10',
      weight_kg: 72,
    });
    expect(prisma.adminClientAssignment.findFirst).not.toHaveBeenCalled();
  });

  it('rejects metric editing by an unassigned admin', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'client-1',
      role: Role.CLIENT,
    });
    prisma.adminClientAssignment.findFirst.mockResolvedValue(null);

    await expect(
      service.updateClientMetric(
        'admin-1',
        Role.ADMIN,
        'client-1',
        'metric-1',
        { waist_cm: 80 },
      ),
    ).rejects.toThrow(
      new ForbiddenException('Este cliente no está asignado a ti'),
    );

    expect(metricsService.updateForClient).not.toHaveBeenCalled();
  });

  it('returns not found when trying to unlock a non-client account', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'admin-2',
      role: Role.ADMIN,
      is_locked: true,
    });

    await expect(
      service.unlockUser('admin-1', Role.ADMIN, 'admin-2'),
    ).rejects.toThrow(
      new ForbiddenException(
        'Solo puedes desbloquear clientes asignados a tu cuenta',
      ),
    );

    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('returns active client assignments for a super admin', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'client-1',
      role: Role.CLIENT,
    });
    prisma.adminClientAssignment.findMany.mockResolvedValue([
      {
        client_id: 'client-1',
        created_at: new Date('2024-01-01T10:00:00.000Z'),
        admin: {
          id: 'admin-1',
          email: 'admin-1@exom.dev',
          profile: {
            first_name: 'Ada',
            last_name: 'Trainer',
            avatar_url: 'https://cdn.exom.dev/a.png',
          },
        },
      },
    ]);

    await expect(
      service.getClientAssignments(
        'super-admin-1',
        Role.SUPER_ADMIN,
        'client-1',
      ),
    ).resolves.toEqual({
      client_id: 'client-1',
      active_admins: [
        {
          id: 'admin-1',
          email: 'admin-1@exom.dev',
          profile: {
            first_name: 'Ada',
            last_name: 'Trainer',
            avatar_url: 'https://cdn.exom.dev/a.png',
          },
          assigned_at: new Date('2024-01-01T10:00:00.000Z'),
        },
      ],
    });

    expect(prisma.adminClientAssignment.findMany).toHaveBeenCalledWith({
      where: {
        client_id: 'client-1',
        is_active: true,
        admin: {
          is: {
            role: Role.ADMIN,
            is_active: true,
          },
        },
      },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
      select: {
        client_id: true,
        created_at: true,
        admin: {
          select: {
            id: true,
            email: true,
            profile: {
              select: {
                first_name: true,
                last_name: true,
                avatar_url: true,
              },
            },
          },
        },
      },
    });
  });

  it('rejects assignment management for non-super-admin users', async () => {
    await expect(
      service.getClientAssignments('admin-1', Role.ADMIN, 'client-1'),
    ).rejects.toThrow(
      new ForbiddenException(
        'Solo un super admin puede gestionar asignaciones de clientes',
      ),
    );

    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.adminClientAssignment.findMany).not.toHaveBeenCalled();
  });

  it('updates client assignments atomically by deactivating, reactivating, and creating relations', async () => {
    const dto: UpdateClientAssignmentsDto = {
      admin_ids: ['admin-2', 'admin-3'],
    };
    prisma.user.findUnique.mockResolvedValue({
      id: 'client-1',
      role: Role.CLIENT,
    });
    prisma.user.findMany.mockResolvedValue([
      { id: 'admin-2' },
      { id: 'admin-3' },
    ]);
    prisma.adminClientAssignment.findMany
      .mockResolvedValueOnce([{ admin_id: 'admin-1' }, { admin_id: 'admin-2' }])
      .mockResolvedValueOnce([
        { id: 'assignment-1', admin_id: 'admin-1', is_active: true },
        { id: 'assignment-2', admin_id: 'admin-2', is_active: false },
      ])
      .mockResolvedValueOnce([
        {
          client_id: 'client-1',
          created_at: new Date('2024-02-01T10:00:00.000Z'),
          admin: {
            id: 'admin-2',
            email: 'admin-2@exom.dev',
            profile: {
              first_name: 'Lin',
              last_name: 'Coach',
              avatar_url: null,
            },
          },
        },
        {
          client_id: 'client-1',
          created_at: new Date('2024-02-02T10:00:00.000Z'),
          admin: {
            id: 'admin-3',
            email: 'admin-3@exom.dev',
            profile: {
              first_name: 'Maya',
              last_name: 'Coach',
              avatar_url: null,
            },
          },
        },
      ]);
    prisma.adminClientAssignment.updateMany.mockResolvedValue({ count: 1 });
    prisma.adminClientAssignment.createMany.mockResolvedValue({ count: 1 });

    await expect(
      service.updateClientAssignments(
        'super-admin-1',
        Role.SUPER_ADMIN,
        'client-1',
        dto,
      ),
    ).resolves.toEqual({
      client_id: 'client-1',
      active_admins: [
        {
          id: 'admin-2',
          email: 'admin-2@exom.dev',
          profile: { first_name: 'Lin', last_name: 'Coach', avatar_url: null },
          assigned_at: new Date('2024-02-01T10:00:00.000Z'),
        },
        {
          id: 'admin-3',
          email: 'admin-3@exom.dev',
          profile: { first_name: 'Maya', last_name: 'Coach', avatar_url: null },
          assigned_at: new Date('2024-02-02T10:00:00.000Z'),
        },
      ],
    });

    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['admin-2', 'admin-3'] },
        role: Role.ADMIN,
        is_active: true,
      },
      select: { id: true },
    });
    expect(prisma.adminClientAssignment.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: { in: ['assignment-1'] } },
      data: { is_active: false },
    });
    expect(prisma.adminClientAssignment.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: { in: ['assignment-2'] } },
      data: { is_active: true },
    });
    expect(prisma.adminClientAssignment.createMany).toHaveBeenCalledWith({
      data: [{ admin_id: 'admin-3', client_id: 'client-1' }],
    });
    expect(notifications.sendInternalTemplate).toHaveBeenCalledWith(
      'super-admin-1',
      ['admin-2', 'admin-3'],
      'admin_client_assigned',
      { clientName: 'Cliente', clientId: 'client-1' },
      {
        title: 'Cliente asignado',
        body: 'Cliente te ha sido asignado',
        route: '/admin/clients/client-1',
      },
      {
        type: 'client_assigned',
        client_id: 'client-1',
      },
    );
  });

  it('rejects assignment updates when any admin is missing or has the wrong role', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'client-1',
      role: Role.CLIENT,
    });
    prisma.user.findMany.mockResolvedValue([{ id: 'admin-1' }]);

    await expect(
      service.updateClientAssignments(
        'super-admin-1',
        Role.SUPER_ADMIN,
        'client-1',
        {
          admin_ids: ['admin-1', 'admin-2'],
        },
      ),
    ).rejects.toThrow(
      new NotFoundException('Uno o más administradores activos no existen'),
    );

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('requests assigned clients with deterministic pagination ordering', async () => {
    prisma.adminClientAssignment.findMany.mockResolvedValue([
      {
        client: {
          id: 'client-1',
          email: 'client-1@exom.dev',
          role: Role.CLIENT,
          is_active: true,
          is_locked: false,
          created_at: new Date('2024-03-02T10:00:00.000Z'),
          profile: null,
          clientOf: [],
        },
      },
    ]);
    prisma.adminClientAssignment.count.mockResolvedValue(1);

    const pagination = new PaginationDto();
    pagination.page = 2;
    pagination.limit = 10;

    await expect(
      service.getMyClients('admin-1', Role.ADMIN, pagination),
    ).resolves.toEqual({
      data: [
        {
          id: 'client-1',
          email: 'client-1@exom.dev',
          role: Role.CLIENT,
          is_active: true,
          is_locked: false,
          created_at: new Date('2024-03-02T10:00:00.000Z'),
          profile: null,
          active_admins_count: 0,
        },
      ],
      total: 1,
      page: 2,
      limit: 10,
      totalPages: 1,
    });

    expect(prisma.adminClientAssignment.findMany).toHaveBeenCalledWith({
      where: {
        admin_id: 'admin-1',
        is_active: true,
        client: {
          is: {
            role: Role.CLIENT,
          },
        },
      },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      skip: 10,
      take: 10,
      include: {
        client: {
          select: {
            id: true,
            email: true,
            role: true,
            is_active: true,
            is_locked: true,
            created_at: true,
            profile: true,
            clientOf: {
              where: {
                is_active: true,
                admin: {
                  is: {
                    role: Role.ADMIN,
                    is_active: true,
                  },
                },
              },
              select: { id: true },
            },
          },
        },
      },
    });

    expect(prisma.adminClientAssignment.count).toHaveBeenCalledWith({
      where: {
        admin_id: 'admin-1',
        is_active: true,
        client: {
          is: {
            role: Role.CLIENT,
          },
        },
      },
    });
  });

  it('filters out non-client assignments from the paginated query', async () => {
    prisma.adminClientAssignment.findMany.mockResolvedValue([]);
    prisma.adminClientAssignment.count.mockResolvedValue(0);

    await service.getMyClients('admin-1', Role.ADMIN, new PaginationDto());

    const expectedWhere = {
      admin_id: 'admin-1',
      is_active: true,
      client: {
        is: {
          role: Role.CLIENT,
        },
      },
    };

    expect(prisma.adminClientAssignment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expectedWhere }),
    );
    expect(prisma.adminClientAssignment.count).toHaveBeenCalledWith({
      where: expectedWhere,
    });
  });

  it('returns all clients for super admin sessions', async () => {
    prisma.user.findMany.mockResolvedValue([
      {
        id: 'client-2',
        email: 'client-2@exom.dev',
        role: Role.CLIENT,
        is_active: true,
        is_locked: false,
        created_at: new Date('2024-03-02T10:00:00.000Z'),
        profile: null,
        clientOf: [],
      },
    ]);
    prisma.user.count.mockResolvedValue(1);

    await expect(
      service.getMyClients(
        'super-admin-1',
        Role.SUPER_ADMIN,
        new PaginationDto(),
      ),
    ).resolves.toEqual({
      data: [
        {
          id: 'client-2',
          email: 'client-2@exom.dev',
          role: Role.CLIENT,
          is_active: true,
          is_locked: false,
          created_at: new Date('2024-03-02T10:00:00.000Z'),
          profile: null,
          active_admins_count: 0,
        },
      ],
      total: 1,
      page: 1,
      limit: 20,
      totalPages: 1,
    });

    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { role: Role.CLIENT },
      skip: 0,
      take: 20,
      select: {
        id: true,
        email: true,
        role: true,
        is_active: true,
        is_locked: true,
        created_at: true,
        profile: true,
        clientOf: {
          where: {
            is_active: true,
            admin: {
              is: {
                role: Role.ADMIN,
                is_active: true,
              },
            },
          },
          select: { id: true },
        },
      },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
    });
    expect(prisma.user.count).toHaveBeenCalledWith({
      where: { role: Role.CLIENT },
    });
    expect(prisma.adminClientAssignment.findMany).not.toHaveBeenCalled();
  });

  it('requests the global users list with deterministic ordering', async () => {
    prisma.user.findMany.mockResolvedValue([]);
    prisma.user.count.mockResolvedValue(0);

    await expect(
      service.findAll(undefined, new PaginationDto()),
    ).resolves.toEqual({
      data: [],
      total: 0,
      page: 1,
      limit: 20,
      totalPages: 0,
    });

    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: {},
      skip: 0,
      take: 20,
      select: {
        id: true,
        email: true,
        role: true,
        is_active: true,
        is_locked: true,
        created_at: true,
        profile: {
          select: { first_name: true, last_name: true, avatar_url: true },
        },
      },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
    });
  });

  it('delegates admin calendar reads to the reconciled calendar service', async () => {
    const month = [{ date: '2026-07-01', has_training: true }];
    const week = { week_start: '2026-06-29', trainings_assigned: 2 };
    calendarService.getMonthCalendar.mockResolvedValue(month);
    calendarService.getWeekSummary.mockResolvedValue(week);

    await expect(
      service.getClientCalendarMonth(
        'super-admin-1',
        Role.SUPER_ADMIN,
        'client-1',
        2026,
        7,
      ),
    ).resolves.toBe(month);
    await expect(
      service.getClientWeekSummary(
        'super-admin-1',
        Role.SUPER_ADMIN,
        'client-1',
        '2026-06-29',
      ),
    ).resolves.toBe(week);

    expect(calendarService.getMonthCalendar).toHaveBeenCalledWith(
      'client-1',
      2026,
      7,
    );
    expect(calendarService.getWeekSummary).toHaveBeenCalledWith(
      'client-1',
      '2026-06-29',
    );
  });
});
