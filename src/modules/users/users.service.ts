import { inPageOrder } from '../../common/query-page';
import { userPage, clientPage, activeAdminWhere } from './users-list-query';
import { enqueueWork } from '../jobs/jobs.service';
import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  Logger,
  Optional,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { IdentityService } from '../identity/identity.service';
import { IdentityProvider } from '../identity/identity-provider';
import { PrismaService } from '../../prisma/prisma.service';
import {
  flattenHistoricalMeals,
  loadDietHistory,
} from '../../common/progress/diet-history';
import { ChallengesService } from '../challenges/challenges.service';
import { STREAK_PUBLIC_SELECT } from '../streaks/streak-public';
import { EmailService } from '../email/email.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AdminClientsQueryDto } from './dto/admin-clients-query.dto';
import { AdminUsersQueryDto } from './dto/admin-users-query.dto';
import { CreateClientDto, UpdateRoleDto } from './dto/create-client.dto';
import {
  CreateAdminDto,
  UpdateUserDto,
  UpdateUserStatusDto,
} from './dto/manage-user.dto';
import { PaginationDto, paginate } from '../../common/dto/pagination.dto';
import { Prisma, Role } from '@prisma/client';
import { UpdateClientAssignmentsDto } from './dto/update-client-assignments.dto';
import { UpdateClientProfileDto } from './dto/update-client-profile.dto';
import type { BodyField } from './dto/admin-client-metrics-query.dto';
import type {
  CreateAdminClientMetricDto,
  UpdateAdminClientMetricDto,
} from './dto/admin-client-metric.dto';
import { MetricsService } from '../metrics/metrics.service';
import { CalendarService } from '../calendar/calendar.service';

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

type ManagedUserRecord = {
  id: string;
  email: string;
  role: Role;
  is_active: boolean;
  is_locked: boolean;
  created_at: Date;
  login_attempts?: number;
  locked_at?: Date | null;
  firebase_uid?: string;
  profile: {
    first_name: string;
    last_name: string;
    avatar_url: string | null;
  } | null;
};

function getDateRange(
  from?: string,
  to?: string,
): Prisma.DateTimeFilter | undefined {
  if (!from && !to) {
    return undefined;
  }

  const range: Prisma.DateTimeFilter = {};

  if (from) {
    range.gte = new Date(`${from}T00:00:00.000Z`);
  }

  if (to) {
    range.lte = new Date(`${to}T23:59:59.999Z`);
  }

  return range;
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly challengesService: ChallengesService,
    private readonly notifications: NotificationsService,
    private readonly metricsService: MetricsService,
    private readonly calendarService: CalendarService,
    @Optional() private readonly emailService?: EmailService,
    private readonly identity: IdentityService = new IdentityService(
      prisma,
      new IdentityProvider(),
    ),
  ) {}

  async findAll(
    roleOrQuery?: Role | AdminUsersQueryDto,
    pagination: PaginationDto = new PaginationDto(),
  ) {
    const query =
      roleOrQuery && typeof roleOrQuery === 'object'
        ? roleOrQuery
        : Object.assign(new AdminUsersQueryDto(), pagination, {
            ...(roleOrQuery ? { role: roleOrQuery } : {}),
          });
    const { role, search, status, created_from, created_to, skip, limit } =
      query;
    const pageSize = limit ?? 20;
    const normalizedSearch = search?.trim();
    const createdAtRange = getDateRange(created_from, created_to);
    const where: Prisma.UserWhereInput = {
      ...(role ? { role } : {}),
      ...(createdAtRange ? { created_at: createdAtRange } : {}),
    };
    const select = {
      id: true,
      email: true,
      role: true,
      is_active: true,
      is_locked: true,
      created_at: true,
      profile: {
        select: { first_name: true, last_name: true, avatar_url: true },
      },
    } as const;

    if (normalizedSearch || status?.length) {
      return this.prisma.$transaction(
        async (tx) => {
          const page = await userPage(tx, query);
          const rows = await tx.user.findMany({
            where: { id: { in: page.ids } },
            select,
          });
          return paginate(inPageOrder(page.ids, rows), page.total, query);
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      );
    }

    const [data, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        skip,
        take: pageSize,
        select,
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      }),
      this.prisma.user.count({ where }),
    ]);
    return paginate(data, total, query);
  }
  async createAdmin(dto: CreateAdminDto, actorId: string, key?: string) {
    const email = this.normalizeEmail(dto.email);
    const firstName = dto.first_name.trim();
    const lastName = dto.last_name.trim();
    const user = await this.identity.create(
      {
        actorId,
        role: Role.ADMIN,
        email,
        firstName,
        lastName,
        password: dto.password ?? this.generateSecureRandomPassword(),
        fingerprint: [firstName, lastName],
        key,
      },
      async (tx, uid, id) => {
        const created = await tx.user.create({
          data: {
            id,
            email,
            firebase_uid: uid,
            role: Role.ADMIN,
            auth_provider: 'email',
            profile: { create: { first_name: firstName, last_name: lastName } },
          },
          include: { profile: true },
        });
        if (!dto.password)
          await enqueueWork(
            tx,
            `email:invitation:${id}`,
            'EMAIL',
            { kind: 'invitation' },
            id,
          );
        return created;
      },
    );
    return this.serializeUserSummary(user);
  }
  async createClient(
    adminId: string,
    currentUserRole: string,
    dto: CreateClientDto,
    key?: string,
  ) {
    const email = this.normalizeEmail(dto.email);
    const firstName = dto.first_name.trim();
    const lastName = dto.last_name.trim();
    const user = await this.identity.create(
      {
        actorId: adminId,
        role: Role.CLIENT,
        email,
        firstName,
        lastName,
        password: dto.password ?? this.generateSecureRandomPassword(),
        fingerprint: [
          firstName,
          lastName,
          dto.level ?? 'PRINCIPIANTE',
          dto.main_goal ?? null,
        ],
        key,
      },
      async (tx, uid, id) => {
        const newUser = await tx.user.create({
          data: {
            id,
            email,
            firebase_uid: uid,
            role: Role.CLIENT,
            auth_provider: 'email',
            profile: {
              create: {
                first_name: firstName,
                last_name: lastName,
                level: dto.level ?? 'PRINCIPIANTE',
                main_goal: dto.main_goal ?? null,
              },
            },
          },
          include: { profile: true },
        });
        // Re-read under IdentityService's actor lock; do not trust a stale role.
        const actor = await tx.user.findUniqueOrThrow({
          where: { id: adminId },
        });
        if (actor.role === Role.ADMIN) {
          await tx.adminClientAssignment.create({
            data: { admin_id: adminId, client_id: newUser.id },
          });
          await this.challengesService.syncGlobalChallengesForCreatorClient(
            adminId,
            newUser.id,
            tx,
          );
        }
        if (!dto.password)
          await enqueueWork(
            tx,
            `email:invitation:${id}`,
            'EMAIL',
            { kind: 'invitation' },
            id,
          );
        if (actor.role === Role.ADMIN)
          await this.notifyClientAssignedToAdmins(
            tx,
            adminId,
            [adminId],
            newUser.id,
            this.buildClientNotificationName(newUser),
          );
        return newUser;
      },
    );

    return this.serializeUserSummary(user);
  }
  async updateUser(
    id: string,
    dto: UpdateUserDto,
    actorId: string,
    key?: string,
  ) {
    const email = this.normalizeEmail(dto.email);
    const firstName = dto.first_name.trim();
    const lastName = dto.last_name.trim();
    const user = await this.identity.change(
      actorId,
      id,
      'SYNC',
      [email, firstName, lastName],
      async (tx) => {
        if (
          await tx.user.findFirst({
            where: {
              id: { not: id },
              email: { equals: email, mode: 'insensitive' },
            },
            select: { id: true },
          })
        )
          throw new ConflictException('El email ya está registrado');
        await tx.user.update({
          where: { id },
          data: {
            email,
            profile: {
              upsert: {
                create: { first_name: firstName, last_name: lastName },
                update: { first_name: firstName, last_name: lastName },
              },
            },
          },
        });
      },
      key,
    );
    return this.serializeUserSummary(user);
  }
  async updateUserStatus(
    currentUserId: string,
    id: string,
    dto: UpdateUserStatusDto,
    key?: string,
  ) {
    if (!dto.is_active && id === currentUserId)
      throw new ForbiddenException('No puedes desactivar tu propia cuenta');
    await this.identity.change(
      currentUserId,
      id,
      'SYNC',
      dto.is_active,
      async (tx, user) => {
        await tx.user.update({
          where: { id },
          data: {
            is_active: dto.is_active,
            is_locked: dto.is_active ? user.is_locked : false,
            login_attempts: dto.is_active ? user.login_attempts : 0,
            locked_at: dto.is_active ? user.locked_at : null,
            ...(!dto.is_active ? { sessions_revoked_at: new Date() } : {}),
          },
        });
      },
      key,
    );
    return {
      message: dto.is_active
        ? 'Cuenta reactivada exitosamente'
        : 'Cuenta desactivada exitosamente',
    };
  }

  async unlockUser(currentUserId: string, currentUserRole: string, id: string) {
    const user = await this.getManageableUserOrFail(
      id,
      currentUserRole === Role.SUPER_ADMIN,
    );

    if (currentUserRole === Role.ADMIN) {
      if (user.role !== Role.CLIENT) {
        throw new ForbiddenException(
          'Solo puedes desbloquear clientes asignados a tu cuenta',
        );
      }

      await this.assertClientAccess(currentUserId, currentUserRole, id);
    }

    await this.prisma.user.update({
      where: { id },
      data: { is_locked: false, login_attempts: 0, locked_at: null },
    });

    return { message: 'Cuenta desbloqueada exitosamente' };
  }

  async updateRole(currentUserId: string, id: string, dto: UpdateRoleDto) {
    const user = await this.getManageableUserOrFail(id, true);

    if (user.id === currentUserId && dto.role !== Role.SUPER_ADMIN) {
      throw new ForbiddenException('No puedes cambiar tu propio rol');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data: { role: dto.role } });

      if (user.role === Role.ADMIN && dto.role !== Role.ADMIN) {
        await tx.adminClientAssignment.updateMany({
          where: { admin_id: id, is_active: true },
          data: { is_active: false },
        });
      }
    });

    return { message: 'Rol actualizado exitosamente' };
  }

  async setClientArchived(
    currentUserId: string,
    currentUserRole: string,
    clientId: string,
    isArchived: boolean,
  ) {
    if (
      currentUserRole !== Role.SUPER_ADMIN &&
      currentUserRole !== Role.ADMIN
    ) {
      throw new ForbiddenException('No tienes permisos para archivar clientes');
    }
    return this.prisma.$transaction(async (tx) => {
      // Read permissions after any wait, in the same user-lock order as deletion.
      // A role from the authentication guard can become stale while we wait.
      await tx.$queryRaw`SELECT id FROM users WHERE id IN (${clientId}, ${currentUserId}) ORDER BY id FOR UPDATE`;
      const actor = await tx.user.findUnique({ where: { id: currentUserId } });
      if (
        !actor ||
        !actor.is_active ||
        actor.is_locked ||
        (actor.role !== Role.SUPER_ADMIN && actor.role !== Role.ADMIN)
      ) {
        throw new ForbiddenException(
          'No tienes permisos para archivar clientes',
        );
      }
      if (actor.role === Role.ADMIN) {
        // Hold the assignment through commit; every UPDATE/DELETE writer must
        // respect this row lock, including bulk revocation and role changes.
        const assignments = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM admin_client_assignments
        WHERE admin_id = ${currentUserId} AND client_id = ${clientId} AND is_active = true
        FOR SHARE`;
        if (!assignments.length) {
          throw new NotFoundException(
            'Cliente no encontrado o sin permiso para gestionarlo',
          );
        }
      }
      const result = await tx.user.updateMany({
        where: {
          id: clientId,
          role: Role.CLIENT,
          ...(actor.role === Role.ADMIN
            ? {
                clientOf: {
                  some: { admin_id: currentUserId, is_active: true },
                },
              }
            : {}),
        },
        data: { is_archived: isArchived },
      });
      if (result.count !== 1) {
        throw new NotFoundException(
          'Cliente no encontrado o sin permiso para gestionarlo',
        );
      }
      return {
        id: clientId,
        is_archived: isArchived,
        message: isArchived ? 'Cliente archivado' : 'Cliente desarchivado',
      };
    });
  }

  async getMyClients(
    currentUserId: string,
    currentUserRole: string,
    query: AdminClientsQueryDto = new AdminClientsQueryDto(),
  ) {
    const {
      search,
      level,
      status,
      assignment_state,
      created_from,
      created_to,
      skip,
      limit,
    } = query;
    const pageSize = limit ?? 20;
    const normalizedSearch = search?.trim();
    const createdAtRange = getDateRange(created_from, created_to);
    // Preserve the legacy all-clients contract for selectors and other readers.
    // The main Admin list explicitly requests visible or archived clients.
    const archiveWhere: Prisma.UserWhereInput =
      query.archive && query.archive !== 'all'
        ? { is_archived: query.archive === 'archived' }
        : {};
    const clientSelect = {
      id: true,
      email: true,
      role: true,
      is_active: true,
      is_locked: true,
      is_archived: true,
      created_at: true,
      profile: true,
      _count: { select: { clientOf: { where: activeAdminWhere } } },
    } as const;
    const mapClientWithAdminCount = <
      T extends {
        _count: { clientOf: number };
        is_active: boolean;
        is_locked: boolean;
        email: string;
        profile: {
          first_name?: string | null;
          last_name?: string | null;
        } | null;
      },
    >(
      client: T,
    ) => {
      const { _count, ...clientData } = client;

      return {
        ...clientData,
        active_admins_count: _count.clientOf,
      };
    };
    if (currentUserRole === Role.SUPER_ADMIN) {
      const where: Prisma.UserWhereInput = {
        role: Role.CLIENT,
        ...archiveWhere,
        ...(level?.length ? { profile: { is: { level: { in: level } } } } : {}),
        ...(createdAtRange ? { created_at: createdAtRange } : {}),
      };

      if (normalizedSearch || status?.length || assignment_state?.length) {
        return this.prisma.$transaction(
          async (tx) => {
            const page = await clientPage(
              tx,
              currentUserId,
              currentUserRole,
              query,
            );
            const rows = await tx.user.findMany({
              where: { id: { in: page.ids } },
              select: clientSelect,
            });
            return paginate(
              inPageOrder(page.ids, rows).map(mapClientWithAdminCount),
              page.total,
              query,
            );
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
        );
      }

      const [clients, total] = await Promise.all([
        this.prisma.user.findMany({
          where,
          skip,
          take: pageSize,
          select: clientSelect,
          orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        }),
        this.prisma.user.count({ where }),
      ]);

      return paginate(clients.map(mapClientWithAdminCount), total, query);
    }

    const where: Prisma.AdminClientAssignmentWhereInput = {
      admin_id: currentUserId,
      is_active: true,
      client: {
        is: {
          role: Role.CLIENT,
          ...archiveWhere,
          ...(level?.length
            ? { profile: { is: { level: { in: level } } } }
            : {}),
          ...(createdAtRange ? { created_at: createdAtRange } : {}),
        },
      },
    };

    if (normalizedSearch || status?.length) {
      return this.prisma.$transaction(
        async (tx) => {
          const page = await clientPage(
            tx,
            currentUserId,
            currentUserRole,
            query,
          );
          const rows = await tx.user.findMany({
            where: { id: { in: page.ids } },
            select: clientSelect,
          });
          return paginate(
            inPageOrder(page.ids, rows).map(mapClientWithAdminCount),
            page.total,
            query,
          );
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      );
    }

    const [assignments, total] = await Promise.all([
      this.prisma.adminClientAssignment.findMany({
        where,
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        skip,
        take: pageSize,
        include: {
          client: {
            select: clientSelect,
          },
        },
      }),
      this.prisma.adminClientAssignment.count({ where }),
    ]);

    return paginate(
      assignments.map(({ client }) => mapClientWithAdminCount(client)),
      total,
      query,
    );
  }

  async updateFcmToken(userId: string, fcmToken: string) {
    await this.prisma.user.update({
      where: { id: userId },
      data: { fcm_token: fcmToken },
    });
    return { message: 'FCM token updated' };
  }

  async getClientProfile(
    currentUserId: string,
    currentUserRole: string,
    clientId: string,
  ) {
    const client = await this.prisma.user.findUnique({
      where: { id: clientId },
      include: {
        profile: true,
        bodyMetrics: {
          orderBy: [{ date: 'desc' }, { created_at: 'desc' }],
          take: 10,
        },
        streak: { select: STREAK_PUBLIC_SELECT },
      },
    });

    if (!client) throw new NotFoundException('Cliente no encontrado');

    if (client.role !== Role.CLIENT) {
      throw new NotFoundException('Cliente no encontrado');
    }

    await this.assertClientAccess(currentUserId, currentUserRole, clientId);

    return client;
  }

  async updateClientProfile(
    currentUserId: string,
    currentUserRole: string,
    clientId: string,
    dto: UpdateClientProfileDto,
  ) {
    const client = await this.prisma.user.findUnique({
      where: { id: clientId },
      select: { id: true, role: true, profile: { select: { id: true } } },
    });

    if (!client || client.role !== Role.CLIENT) {
      throw new NotFoundException('Cliente no encontrado');
    }

    await this.assertClientAccess(currentUserId, currentUserRole, clientId);

    const profileData = {
      ...(dto.first_name !== undefined && {
        first_name: dto.first_name.trim(),
      }),
      ...(dto.last_name !== undefined && { last_name: dto.last_name.trim() }),
      ...(dto.level !== undefined && { level: dto.level }),
      ...(dto.main_goal !== undefined && {
        main_goal: dto.main_goal?.trim() || null,
      }),
      ...(dto.muscle_mass_goal !== undefined && {
        muscle_mass_goal: dto.muscle_mass_goal,
      }),
      ...(dto.target_calories !== undefined && {
        target_calories: dto.target_calories,
      }),
      ...(dto.current_weight !== undefined && {
        current_weight: dto.current_weight,
      }),
      ...(dto.height !== undefined && { height: dto.height }),
      ...(dto.birth_date !== undefined && { birth_date: dto.birth_date }),
    };

    await this.prisma.user.update({
      where: { id: clientId },
      data: {
        profile: {
          upsert: {
            create: {
              first_name: dto.first_name?.trim() ?? '',
              last_name: dto.last_name?.trim() ?? '',
              ...profileData,
            },
            update: profileData,
          },
        },
      },
    });

    return this.getClientProfile(currentUserId, currentUserRole, clientId);
  }

  async getClientAssignments(
    currentUserId: string,
    currentUserRole: string,
    clientId: string,
  ) {
    this.assertSuperAdminAccess(currentUserId, currentUserRole);
    await this.assertClientExists(clientId);

    const assignments = await this.prisma.adminClientAssignment.findMany({
      where: {
        client_id: clientId,
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
    await this.assertAdminUsersExist(desiredAdminIds);

    const result = await this.prisma.$transaction(async (tx) => {
      const currentActiveAssignments = await tx.adminClientAssignment.findMany({
        where: { client_id: clientId, is_active: true },
        select: { admin_id: true },
      });
      const adminIdsToSync = [
        ...new Set([
          ...currentActiveAssignments.map((assignment) => assignment.admin_id),
          ...desiredAdminIds,
        ]),
      ];

      const syncResult = await this.syncClientAssignments(
        tx,
        clientId,
        desiredAdminIds,
      );

      await Promise.all(
        adminIdsToSync.map((adminId) =>
          this.challengesService.syncGlobalChallengesForCreatorClient(
            adminId,
            clientId,
            tx,
          ),
        ),
      );

      const assignments = await tx.adminClientAssignment.findMany({
        where: {
          client_id: clientId,
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

      const client = await tx.user.findUnique({
        where: { id: clientId },
        select: {
          email: true,
          profile: {
            select: {
              first_name: true,
              last_name: true,
            },
          },
        },
      });

      await this.notifyClientAssignedToAdmins(
        tx,
        currentUserId,
        syncResult.assignedAdminIds,
        clientId,
        this.buildClientNotificationName(client),
      );
      return {
        response: this.serializeClientAssignments(clientId, assignments),
        assignedAdminIds: syncResult.assignedAdminIds,
        clientName: this.buildClientNotificationName(client),
      };
    });

    return result.response;
  }

  private async assertClientAccess(
    currentUserId: string,
    currentUserRole: string,
    clientId: string,
  ) {
    if (currentUserRole === Role.SUPER_ADMIN) {
      return;
    }

    if (currentUserRole !== Role.ADMIN) {
      throw new ForbiddenException(
        'No tienes permisos para acceder a este cliente',
      );
    }

    const assignment = await this.prisma.adminClientAssignment.findFirst({
      where: { admin_id: currentUserId, client_id: clientId, is_active: true },
    });

    if (!assignment) {
      throw new ForbiddenException('Este cliente no está asignado a ti');
    }
  }

  private assertSuperAdminAccess(
    currentUserId: string,
    currentUserRole: string,
  ) {
    if (currentUserRole === Role.SUPER_ADMIN) {
      return;
    }

    this.logger.warn(
      `User ${currentUserId} attempted to manage client assignments without SUPER_ADMIN role`,
    );
    throw new ForbiddenException(
      'Solo un super admin puede gestionar asignaciones de clientes',
    );
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
    if (adminIds.length === 0) {
      return [];
    }

    const admins = await this.prisma.user.findMany({
      where: {
        id: { in: adminIds },
        role: Role.ADMIN,
        is_active: true,
      },
      select: { id: true },
    });

    if (admins.length !== adminIds.length) {
      throw new NotFoundException(
        'Uno o más administradores activos no existen',
      );
    }

    return admins;
  }

  private async getManageableUserOrFail(id: string, includeSuperAdmin = false) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: {
        profile: {
          select: {
            first_name: true,
            last_name: true,
            avatar_url: true,
          },
        },
      },
    });

    if (!user || (!includeSuperAdmin && user.role === Role.SUPER_ADMIN)) {
      throw new NotFoundException('Usuario no encontrado');
    }

    return user;
  }

  private generateSecureRandomPassword(): string {
    return randomBytes(24).toString('base64url').slice(0, 32);
  }

  private async sendInvitationEmail(email: string): Promise<void> {
    if (this.emailService) {
      await this.emailService.sendPasswordActionEmail(email, 'invitation');
      return;
    }

    throw new InternalServerErrorException('EMAIL_WORKER_UNAVAILABLE');
  }

  async resendInvitation(
    currentUserId: string,
    currentUserRole: string,
    targetUserId: string,
  ) {
    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, email: true, role: true },
    });

    if (!target) throw new NotFoundException('Usuario no encontrado');

    if (currentUserRole !== Role.SUPER_ADMIN) {
      if (target.role !== Role.CLIENT) {
        throw new ForbiddenException('Sin permisos');
      }
      await this.assertClientAccess(
        currentUserId,
        currentUserRole,
        targetUserId,
      );
    }

    await this.sendInvitationEmail(target.email);
    return { message: 'Invitación reenviada' };
  }

  private serializeUserSummary(user: ManagedUserRecord) {
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

  private buildClientNotificationName(
    user: {
      email?: string | null;
      profile?: {
        first_name?: string | null;
        last_name?: string | null;
      } | null;
    } | null,
  ) {
    const fullName = [user?.profile?.first_name, user?.profile?.last_name]
      .filter(Boolean)
      .join(' ')
      .trim();

    return fullName || user?.email || 'Cliente';
  }

  private async notifyClientAssignedToAdmins(
    tx: Prisma.TransactionClient,
    senderId: string,
    adminIds: string[],
    clientId: string,
    clientName: string,
  ) {
    const uniqueAdminIds = [...new Set(adminIds.filter(Boolean))];
    if (uniqueAdminIds.length === 0) {
      return;
    }

    await this.notifications.queueTemplate(
      tx,
      senderId,
      uniqueAdminIds,
      'admin_client_assigned',
      { clientName, clientId },
      {
        title: 'Cliente asignado',
        body: `${clientName} te ha sido asignado`,
        route: `/admin/clients/${clientId}`,
      },
      {
        type: 'client_assigned',
        client_id: clientId,
      },
    );
  }

  private normalizeEmail(email: string) {
    return email.trim().toLowerCase();
  }

  private serializeClientAssignments(
    clientId: string,
    assignments: ClientAssignmentRecord[],
  ) {
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

  async getClientDayProgress(
    adminId: string,
    adminRole: string,
    clientId: string,
    date: string,
  ) {
    await this.assertClientAccess(adminId, adminRole, clientId);

    const progress = await this.prisma.dayProgress.findFirst({
      where: { client_id: clientId, date: new Date(date) },
    });

    const dietHistory = await loadDietHistory(
      this.prisma,
      [clientId],
      new Date(date),
    );

    if (!progress && dietHistory.length) {
      return {
        id: null,
        client_id: clientId,
        date: new Date(date),
        training_completed: false,
        trainings_completed: [],
        exercises_completed: [],
        meals_completed: [],
        meals_completed_details: [],
        notes: null,
        admin_reply_text: null,
        admin_reply_sent_at: null,
        diet_history: dietHistory,
      };
    }
    if (!progress) {
      return null;
    }

    const completedExercises = Array.isArray(progress.exercises_completed)
      ? (progress.exercises_completed as Array<{
          exercise_id: string;
          [key: string]: unknown;
        }>)
      : [];
    const exerciseIds = [
      ...new Set(
        completedExercises.map((entry) => entry.exercise_id).filter(Boolean),
      ),
    ];
    const mealIds = [...new Set(progress.meals_completed)];

    const [exercises, meals] = await Promise.all([
      exerciseIds.length
        ? this.prisma.exercise.findMany({
            where: { id: { in: exerciseIds } },
            select: { id: true, name: true },
          })
        : Promise.resolve([]),
      mealIds.length
        ? this.prisma.meal.findMany({
            where: { id: { in: mealIds } },
            select: { id: true, name: true },
          })
        : Promise.resolve([]),
    ]);

    const exerciseNames = new Map<string, string>(
      exercises.map(
        (exercise) => [exercise.id, exercise.name] as [string, string],
      ),
    );
    const mealNames = new Map<string, string>(
      meals.map((meal) => [meal.id, meal.name] as [string, string]),
    );
    // Immutable evidence wins over a renamed/deleted live catalog row.
    for (const entry of dietHistory) {
      for (const meal of flattenHistoricalMeals(entry.diet)) {
        mealNames.set(meal.id, meal.name);
      }
    }

    return {
      ...progress,
      diet_history: dietHistory,
      exercises_completed: completedExercises.map((entry) => ({
        ...entry,
        exercise_name: exerciseNames.get(entry.exercise_id) ?? null,
      })),
      meals_completed_details: progress.meals_completed.map((mealId) => ({
        meal_id: mealId,
        meal_name: mealNames.get(mealId) ?? null,
      })),
    };
  }

  async replyToTrainingNote(
    adminId: string,
    adminRole: string,
    clientId: string,
    date: string,
    reply: string,
  ) {
    await this.assertClientAccess(adminId, adminRole, clientId);

    const progress = await this.prisma.dayProgress.findFirst({
      where: { client_id: clientId, date: new Date(date) },
    });

    if (!progress) {
      throw new NotFoundException('Progreso del día no encontrado');
    }

    if (!progress.notes?.trim()) {
      throw new BadRequestException(
        'El progreso no contiene una nota del cliente',
      );
    }

    const normalizedReply = reply.trim() || null;
    const previousReply = progress.admin_reply_text?.trim() || null;

    if (normalizedReply === previousReply) {
      return progress;
    }

    const updatedProgress = await this.prisma.dayProgress.update({
      where: { id: progress.id },
      data: {
        admin_reply_text: normalizedReply,
        admin_reply_sent_at: normalizedReply ? new Date() : null,
      },
    });

    if (normalizedReply) {
      const trainingId = progress.trainings_completed[0];
      const route = trainingId
        ? `/trainings/${trainingId}?date=${date}`
        : `/trainings?date=${date}`;

      this.notifications
        .sendToUser(
          adminId,
          clientId,
          'Tu entrenador ha respondido a tu nota',
          'Abre el entreno para leer su respuesta.',
          {
            type: 'training_note_reply',
            route,
          },
        )
        .catch((error: unknown) => {
          const message =
            error instanceof Error ? error.message : String(error);
          this.logger.warn(
            `Failed to send training note reply notification to ${clientId}: ${message}`,
          );
        });
    }

    return updatedProgress;
  }

  async getClientCalendarMonth(
    adminId: string,
    adminRole: string,
    clientId: string,
    year: number,
    month: number,
  ) {
    await this.assertClientAccess(adminId, adminRole, clientId);

    return this.calendarService.getMonthCalendar(clientId, year, month);
  }

  async getClientWeekSummary(
    adminId: string,
    adminRole: string,
    clientId: string,
    weekStart: string,
  ) {
    await this.assertClientAccess(adminId, adminRole, clientId);

    return this.calendarService.getWeekSummary(clientId, weekStart);
  }

  async getClientMetrics(
    adminId: string,
    adminRole: string,
    clientId: string,
    pagination: PaginationDto,
  ) {
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

  async createClientMetric(
    adminId: string,
    adminRole: string,
    clientId: string,
    dto: CreateAdminClientMetricDto,
  ) {
    await this.assertClientExists(clientId);
    await this.assertClientAccess(adminId, adminRole, clientId);
    return this.metricsService.createForClient(clientId, dto);
  }

  async updateClientMetric(
    adminId: string,
    adminRole: string,
    clientId: string,
    metricId: string,
    dto: UpdateAdminClientMetricDto,
  ) {
    await this.assertClientExists(clientId);
    await this.assertClientAccess(adminId, adminRole, clientId);
    return this.metricsService.updateForClient(clientId, metricId, dto);
  }

  async getClientWeightHistory(
    adminId: string,
    adminRole: string,
    clientId: string,
  ) {
    await this.assertClientAccess(adminId, adminRole, clientId);

    const metrics = await this.prisma.bodyMetric.findMany({
      where: { client_id: clientId, weight_kg: { not: null } },
      orderBy: { date: 'asc' },
      select: { date: true, weight_kg: true },
    });

    return metrics.map((m) => ({
      date: m.date.toISOString().split('T')[0],
      value: m.weight_kg,
    }));
  }

  async getClientBodyHistory(
    adminId: string,
    adminRole: string,
    clientId: string,
    field: BodyField,
  ) {
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
      (assignment) =>
        assignment.is_active && !desiredAdminIdSet.has(assignment.admin_id),
    );
    const assignmentsToReactivate = currentAssignments.filter(
      (assignment) =>
        !assignment.is_active && desiredAdminIdSet.has(assignment.admin_id),
    );
    const adminIdsToCreate = desiredAdminIds.filter(
      (adminId) => !assignmentsByAdminId.has(adminId),
    );

    await Promise.all([
      assignmentsToDeactivate.length > 0
        ? tx.adminClientAssignment.updateMany({
            where: {
              id: {
                in: assignmentsToDeactivate.map((assignment) => assignment.id),
              },
            },
            data: { is_active: false },
          })
        : Promise.resolve(),
      assignmentsToReactivate.length > 0
        ? tx.adminClientAssignment.updateMany({
            where: {
              id: {
                in: assignmentsToReactivate.map((assignment) => assignment.id),
              },
            },
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

    return {
      assignedAdminIds: [
        ...assignmentsToReactivate.map((assignment) => assignment.admin_id),
        ...adminIdsToCreate,
      ],
    };
  }
}
