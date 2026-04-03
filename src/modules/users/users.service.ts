import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import * as admin from 'firebase-admin';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateClientDto, UpdateRoleDto } from './dto/create-client.dto';
import { PaginationDto, paginate } from '../../common/dto/pagination.dto';
import { Prisma, Role } from '@prisma/client';
import { UpdateClientAssignmentsDto } from './dto/update-client-assignments.dto';
import type { BodyField } from './dto/admin-client-metrics-query.dto';

type ClientAssignmentRecord = {
  client_id: string;
  created_at: Date;
  admin: {
    id: string;
    email: string;
    profile: {
      first_name: string | null;
      last_name: string | null;
      avatar_url: string | null;
    } | null;
  };
};

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(private readonly prisma: PrismaService) {}

  async findAll(roleFilter?: Role, pagination: PaginationDto = new PaginationDto()) {
    const where = roleFilter ? { role: roleFilter } : {};
    const [data, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        skip: pagination.skip,
        take: pagination.limit,
        select: {
          id: true,
          email: true,
          role: true,
          is_active: true,
          is_locked: true,
          created_at: true,
          profile: { select: { first_name: true, last_name: true, avatar_url: true } },
        },
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      }),
      this.prisma.user.count({ where }),
    ]);
    return paginate(data, total, pagination);
  }

  async createClient(adminId: string, dto: CreateClientDto) {
    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (existing) throw new ConflictException('El email ya está registrado');

    let firebaseUser: admin.auth.UserRecord;
    try {
      firebaseUser = await admin.auth().createUser({
        email: dto.email,
        password: dto.password,
        displayName: `${dto.first_name} ${dto.last_name}`,
      });
    } catch (err: any) {
      if (err.code === 'auth/email-already-exists') {
        throw new ConflictException('El email ya está registrado en Firebase');
      }
      throw err;
    }

    const user = await this.prisma.$transaction(async (tx) => {
      const newUser = await tx.user.create({
        data: {
          email: dto.email,
          firebase_uid: firebaseUser.uid,
          role: Role.CLIENT,
          auth_provider: 'email',
          profile: {
            create: {
              first_name: dto.first_name,
              last_name: dto.last_name,
              level: dto.level ?? 'PRINCIPIANTE',
              main_goal: dto.main_goal ?? null,
            },
          },
        },
        include: { profile: true },
      });

      await tx.adminClientAssignment.create({
        data: { admin_id: adminId, client_id: newUser.id },
      });

      return newUser;
    });

    return {
      id: user.id,
      email: user.email,
      role: user.role,
      is_active: user.is_active,
      is_locked: user.is_locked,
      created_at: user.created_at,
      profile: user.profile,
    };
  }

  async unlockUser(id: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user || user.role !== Role.CLIENT) {
      throw new NotFoundException('Cliente no encontrado');
    }

    await this.prisma.user.update({
      where: { id },
      data: { is_locked: false, login_attempts: 0, locked_at: null },
    });

    return { message: 'Cuenta desbloqueada exitosamente' };
  }

  async updateRole(id: string, dto: UpdateRoleDto) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('Usuario no encontrado');

    await this.prisma.user.update({ where: { id }, data: { role: dto.role } });
    return { message: 'Rol actualizado exitosamente' };
  }

  async getMyClients(
    currentUserId: string,
    currentUserRole: string,
    pagination: PaginationDto = new PaginationDto(),
  ) {
    const clientSelect = {
      id: true,
      email: true,
      role: true,
      is_active: true,
      is_locked: true,
      created_at: true,
      profile: true,
    } as const;

    if (currentUserRole === Role.SUPER_ADMIN) {
      const where = { role: Role.CLIENT };

      const [clients, total] = await Promise.all([
        this.prisma.user.findMany({
          where,
          skip: pagination.skip,
          take: pagination.limit,
          select: clientSelect,
          orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        }),
        this.prisma.user.count({ where }),
      ]);

      return paginate(clients, total, pagination);
    }

    const where = {
      admin_id: currentUserId,
      is_active: true,
      client: {
        is: {
          role: Role.CLIENT,
        },
      },
    };

    const [assignments, total] = await Promise.all([
      this.prisma.adminClientAssignment.findMany({
        where,
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        skip: pagination.skip,
        take: pagination.limit,
        include: {
          client: {
            select: clientSelect,
          },
        },
      }),
      this.prisma.adminClientAssignment.count({ where }),
    ]);

    return paginate(
      assignments.map((a) => a.client),
      total,
      pagination,
    );
  }

  async updateFcmToken(userId: string, fcmToken: string) {
    await this.prisma.user.update({
      where: { id: userId },
      data: { fcm_token: fcmToken },
    });
    return { message: 'FCM token updated' };
  }

  async getClientProfile(currentUserId: string, currentUserRole: string, clientId: string) {
    const client = await this.prisma.user.findUnique({
      where: { id: clientId },
      include: {
        profile: true,
        bodyMetrics: { orderBy: { created_at: 'desc' }, take: 10 },
        streak: true,
      },
    });

    if (!client) throw new NotFoundException('Cliente no encontrado');

    if (client.role !== Role.CLIENT) {
      throw new NotFoundException('Cliente no encontrado');
    }

    await this.assertClientAccess(currentUserId, currentUserRole, clientId);

    return client;
  }

  async getClientAssignments(currentUserId: string, currentUserRole: string, clientId: string) {
    this.assertSuperAdminAccess(currentUserId, currentUserRole);
    await this.assertClientExists(clientId);

    const assignments = await this.prisma.adminClientAssignment.findMany({
      where: { client_id: clientId, is_active: true },
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

    return this.serializeClientAssignments(clientId, assignments);
  }

  async updateClientAssignments(
    currentUserId: string,
    currentUserRole: string,
    clientId: string,
    dto: UpdateClientAssignmentsDto,
  ) {
    this.assertSuperAdminAccess(currentUserId, currentUserRole);
    await this.assertClientExists(clientId);

    const desiredAdminIds = [...new Set(dto.admin_ids)];
    if (desiredAdminIds.length === 0) {
      throw new BadRequestException('El cliente debe tener al menos un admin activo');
    }

    await this.assertAdminUsersExist(desiredAdminIds);

    return this.prisma.$transaction(async (tx) => {
      await this.syncClientAssignments(tx, clientId, desiredAdminIds);

      const assignments = await tx.adminClientAssignment.findMany({
        where: { client_id: clientId, is_active: true },
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

      if (assignments.length === 0) {
        throw new BadRequestException('El cliente debe tener al menos un admin activo');
      }

      return this.serializeClientAssignments(clientId, assignments);
    });
  }

  private async assertClientAccess(currentUserId: string, currentUserRole: string, clientId: string) {
    if (currentUserRole === Role.SUPER_ADMIN) {
      return;
    }

    if (currentUserRole !== Role.ADMIN) {
      throw new ForbiddenException('No tienes permisos para acceder a este cliente');
    }

    const assignment = await this.prisma.adminClientAssignment.findFirst({
      where: { admin_id: currentUserId, client_id: clientId, is_active: true },
    });

    if (!assignment) {
      throw new ForbiddenException('Este cliente no está asignado a ti');
    }
  }

  private assertSuperAdminAccess(currentUserId: string, currentUserRole: string) {
    if (currentUserRole === Role.SUPER_ADMIN) {
      return;
    }

    this.logger.warn(
      `User ${currentUserId} attempted to manage client assignments without SUPER_ADMIN role`,
    );
    throw new ForbiddenException('Solo un super admin puede gestionar asignaciones de clientes');
  }

  private async assertClientExists(clientId: string) {
    const client = await this.prisma.user.findUnique({
      where: { id: clientId },
      select: { id: true, role: true },
    });

    if (!client || client.role !== Role.CLIENT) {
      throw new NotFoundException('Cliente no encontrado');
    }

    return client;
  }

  private async assertAdminUsersExist(adminIds: string[]) {
    const admins = await this.prisma.user.findMany({
      where: {
        id: { in: adminIds },
        role: Role.ADMIN,
      },
      select: { id: true },
    });

    if (admins.length !== adminIds.length) {
      throw new NotFoundException('Uno o más administradores no existen');
    }

    return admins;
  }

  private serializeClientAssignments(clientId: string, assignments: ClientAssignmentRecord[]) {
    return {
      client_id: clientId,
      active_admins: assignments.map((assignment) => ({
        id: assignment.admin.id,
        email: assignment.admin.email,
        profile: assignment.admin.profile,
        assigned_at: assignment.created_at,
      })),
    };
  }

  // ─── Admin Progress Endpoints ─────────────────────────────────────────────

  async getClientDayProgress(adminId: string, adminRole: string, clientId: string, date: string) {
    await this.assertClientAccess(adminId, adminRole, clientId);

    const progress = await this.prisma.dayProgress.findFirst({
      where: { client_id: clientId, date: new Date(date) },
    });

    return progress;
  }

  async getClientCalendarMonth(
    adminId: string,
    adminRole: string,
    clientId: string,
    year: number,
    month: number,
  ) {
    await this.assertClientAccess(adminId, adminRole, clientId);

    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0);

    const [assignments, progress] = await Promise.all([
      this.prisma.planAssignment.findMany({
        where: {
          client_id: clientId,
          date: { gte: startDate, lte: endDate },
        },
      }),
      this.prisma.dayProgress.findMany({
        where: {
          client_id: clientId,
          date: { gte: startDate, lte: endDate },
        },
      }),
    ]);

    const assignmentByDate = new Map(
      assignments.map((a) => [a.date.toISOString().split('T')[0], a]),
    );
    const progressByDate = new Map(
      progress.map((p) => [p.date.toISOString().split('T')[0], p]),
    );

    const days: Array<{
      date: string;
      has_training: boolean;
      has_diet: boolean;
      is_rest_day: boolean;
      training_completed: boolean;
      diet_completed: boolean;
    }> = [];

    for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
      const dateStr = d.toISOString().split('T')[0];
      const assignment = assignmentByDate.get(dateStr);
      const dayProgress = progressByDate.get(dateStr);

      days.push({
        date: dateStr,
        has_training: Boolean(assignment?.training_id),
        has_diet: Boolean(assignment?.diet_id),
        is_rest_day: assignment ? assignment.is_rest_day : true,
        training_completed: dayProgress?.training_completed ?? false,
        diet_completed: dayProgress ? dayProgress.meals_completed.length > 0 : false,
      });
    }

    return days;
  }

  async getClientWeekSummary(
    adminId: string,
    adminRole: string,
    clientId: string,
    weekStart: string,
  ) {
    await this.assertClientAccess(adminId, adminRole, clientId);

    const start = new Date(weekStart);
    const end = new Date(weekStart);
    end.setDate(end.getDate() + 6);

    const [assignments, progress] = await Promise.all([
      this.prisma.planAssignment.findMany({
        where: {
          client_id: clientId,
          date: { gte: start, lte: end },
        },
        include: { diet: { include: { meals: true } } },
      }),
      this.prisma.dayProgress.findMany({
        where: {
          client_id: clientId,
          date: { gte: start, lte: end },
        },
      }),
    ]);

    const progressByDate = new Map(
      progress.map((p) => [p.date.toISOString().split('T')[0], p]),
    );

    let trainingsAssigned = 0;
    let trainingsCompleted = 0;
    let totalMeals = 0;
    let mealsCompleted = 0;

    for (const assignment of assignments) {
      if (assignment.is_rest_day) continue;

      const dateStr = assignment.date.toISOString().split('T')[0];
      const dayProgress = progressByDate.get(dateStr);

      if (assignment.training_id) {
        trainingsAssigned += 1;
        if (dayProgress?.training_completed) trainingsCompleted += 1;
      }

      if (assignment.diet_id) {
        const mealCount = assignment.diet?.meals?.length ?? 0;
        totalMeals += mealCount;
        mealsCompleted += dayProgress?.meals_completed?.length ?? 0;
      }
    }

    return {
      week_start: weekStart,
      trainings_assigned: trainingsAssigned,
      trainings_completed: trainingsCompleted,
      total_meals: totalMeals,
      meals_completed: mealsCompleted,
    };
  }

  async getClientMetrics(adminId: string, adminRole: string, clientId: string, pagination: PaginationDto) {
    await this.assertClientAccess(adminId, adminRole, clientId);

    const [data, total] = await Promise.all([
      this.prisma.bodyMetric.findMany({
        where: { client_id: clientId },
        orderBy: { date: 'desc' },
        skip: pagination.skip,
        take: pagination.limit,
      }),
      this.prisma.bodyMetric.count({ where: { client_id: clientId } }),
    ]);

    return paginate(data, total, pagination);
  }

  async getClientWeightHistory(adminId: string, adminRole: string, clientId: string) {
    await this.assertClientAccess(adminId, adminRole, clientId);

    const metrics = await this.prisma.bodyMetric.findMany({
      where: { client_id: clientId, weight_kg: { not: null } },
      orderBy: { date: 'asc' },
      select: { date: true, weight_kg: true },
    });

    return metrics.map((m) => ({ date: m.date.toISOString().split('T')[0], value: m.weight_kg }));
  }

  async getClientBodyHistory(adminId: string, adminRole: string, clientId: string, field: BodyField) {
    await this.assertClientAccess(adminId, adminRole, clientId);

    const metrics = await this.prisma.bodyMetric.findMany({
      where: { client_id: clientId, [field]: { not: null } },
      orderBy: { date: 'asc' },
      select: { date: true, [field]: true },
    });

    return metrics.map((m) => ({
      date: (m.date as Date).toISOString().split('T')[0],
      value: m[field as keyof typeof m] as number,
    }));
  }

  // ──────────────────────────────────────────────────────────────────────────

  private async syncClientAssignments(
    tx: Prisma.TransactionClient,
    clientId: string,
    desiredAdminIds: string[],
  ) {
    const currentAssignments = await tx.adminClientAssignment.findMany({
      where: { client_id: clientId },
      select: { id: true, admin_id: true, is_active: true },
    });

    const desiredAdminIdSet = new Set(desiredAdminIds);
    const assignmentsByAdminId = new Map(
      currentAssignments.map((assignment) => [assignment.admin_id, assignment]),
    );
    const assignmentsToDeactivate = currentAssignments.filter(
      (assignment) => assignment.is_active && !desiredAdminIdSet.has(assignment.admin_id),
    );
    const assignmentsToReactivate = currentAssignments.filter(
      (assignment) => !assignment.is_active && desiredAdminIdSet.has(assignment.admin_id),
    );
    const adminIdsToCreate = desiredAdminIds.filter((adminId) => !assignmentsByAdminId.has(adminId));

    await Promise.all([
      assignmentsToDeactivate.length > 0
        ? tx.adminClientAssignment.updateMany({
            where: { id: { in: assignmentsToDeactivate.map((assignment) => assignment.id) } },
            data: { is_active: false },
          })
        : Promise.resolve(),
      assignmentsToReactivate.length > 0
        ? tx.adminClientAssignment.updateMany({
            where: { id: { in: assignmentsToReactivate.map((assignment) => assignment.id) } },
            data: { is_active: true },
          })
        : Promise.resolve(),
      adminIdsToCreate.length > 0
        ? tx.adminClientAssignment.createMany({
            data: adminIdsToCreate.map((adminId) => ({
              admin_id: adminId,
              client_id: clientId,
            })),
          })
        : Promise.resolve(),
    ]);
  }
}
