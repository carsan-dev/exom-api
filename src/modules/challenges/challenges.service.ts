import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ChallengeAssignmentSource,
  ChallengeType,
  Prisma,
  Role,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { paginate } from '../../common/dto/pagination.dto';
import { AchievementsService } from '../achievements/achievements.service';
import {
  CreateChallengeDto,
  AssignChallengeDto,
  UpdateChallengeDto,
  UpdateProgressDto,
} from './dto/create-challenge.dto';
import {
  type ChallengeCompletionStatus,
  ChallengeAssignmentsQueryDto,
  ChallengesQueryDto,
} from './dto/challenges-query.dto';
import { type ChallengeRuleKey } from './challenges.constants';

type PrismaClientLike = PrismaService | Prisma.TransactionClient;

const ADMIN_CHALLENGE_SELECT = {
  id: true,
  title: true,
  description: true,
  type: true,
  target_value: true,
  unit: true,
  is_manual: true,
  is_global: true,
  deadline: true,
  rule_key: true,
  rule_config: true,
  created_by: true,
  created_at: true,
  updated_at: true,
} as const;

const CHALLENGE_CLIENT_SELECT = {
  id: true,
  client_id: true,
  current_value: true,
  is_completed: true,
  completed_at: true,
  assigned_at: true,
  client: {
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
} as const;

type AdminChallengeRecord = Prisma.ChallengeGetPayload<{
  select: typeof ADMIN_CHALLENGE_SELECT;
}>;

type ChallengeClientRecord = Prisma.ChallengeClientGetPayload<{
  select: typeof CHALLENGE_CLIENT_SELECT;
}>;

@Injectable()
export class ChallengesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly achievementsService: AchievementsService,
  ) {}

  private async evaluateAchievementsForClient(
    clientId: string,
    prisma: PrismaClientLike = this.prisma,
  ) {
    await this.achievementsService.evaluateAutomaticAchievementsForUser(
      clientId,
      prisma,
    );
  }

  private normalizeDate(date: Date) {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  }

  private normalizeEndOfDay(date: Date) {
    const normalized = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    normalized.setUTCHours(23, 59, 59, 999);
    return normalized;
  }

  private getChallengeWindow(assignedAt: Date, deadline: Date | null) {
    const start = this.normalizeDate(assignedAt);
    const now = new Date();
    const deadlineEnd = deadline ? this.normalizeEndOfDay(deadline) : now;
    const end = deadlineEnd.getTime() < now.getTime() ? deadlineEnd : now;

    return { start, end };
  }

  private isDateInRange(date: Date, start: Date, end: Date) {
    const value = date.getTime();
    return value >= start.getTime() && value <= end.getTime();
  }

  private calculateCompletionRate(assignedClients: number, completedClients: number) {
    if (assignedClients === 0) {
      return 0;
    }

    return Math.round((completedClients / assignedClients) * 100);
  }

  private async resolveVisibleClientIds(
    adminId: string,
    adminRole: string,
    prisma: PrismaClientLike = this.prisma,
  ) {
    if (adminRole === Role.SUPER_ADMIN) {
      const clients = await prisma.user.findMany({
        where: { role: Role.CLIENT },
        select: { id: true },
      });

      return clients.map((client) => client.id);
    }

    if (adminRole !== Role.ADMIN) {
      return [];
    }

    const assignments = await prisma.adminClientAssignment.findMany({
      where: { admin_id: adminId, is_active: true },
      select: { client_id: true },
    });

    return assignments.map((assignment) => assignment.client_id);
  }

  private async getGlobalAssignmentClientIds(
    challengeId: string,
    prisma: PrismaClientLike = this.prisma,
  ) {
    const assignments = await prisma.challengeClient.findMany({
      where: {
        challenge_id: challengeId,
        assignment_source: ChallengeAssignmentSource.GLOBAL,
      },
      select: { client_id: true },
    });

    return [...new Set(assignments.map((assignment) => assignment.client_id))];
  }

  private async resolveChallengeCreatorScope(
    challenge: AdminChallengeRecord,
    prisma: PrismaClientLike = this.prisma,
  ) {
    if (!challenge.created_by) {
      return this.getGlobalAssignmentClientIds(challenge.id, prisma);
    }

    const creator = await prisma.user.findUnique({
      where: { id: challenge.created_by },
      select: { id: true, role: true },
    });

    if (
      !creator ||
      (creator.role !== Role.ADMIN && creator.role !== Role.SUPER_ADMIN)
    ) {
      return this.getGlobalAssignmentClientIds(challenge.id, prisma);
    }

    return this.resolveVisibleClientIds(creator.id, creator.role, prisma);
  }

  private async getAssignedClientIds(
    challengeId: string,
    prisma: PrismaClientLike = this.prisma,
  ) {
    const assignments = await prisma.challengeClient.findMany({
      where: { challenge_id: challengeId },
      select: { client_id: true },
    });

    return [...new Set(assignments.map((assignment) => assignment.client_id))];
  }

  private buildVisibleChallengeClientWhere(
    adminRole: string,
    visibleClientIds: string[],
  ): Prisma.ChallengeClientWhereInput {
    if (adminRole === Role.SUPER_ADMIN) {
      return {};
    }

    return {
      client_id: { in: visibleClientIds },
    };
  }

  private buildCompletionStatusWhere(
    status: ChallengeCompletionStatus,
    adminRole: string,
    visibleClientIds: string[],
  ): Prisma.ChallengeWhereInput {
    if (adminRole !== Role.SUPER_ADMIN && visibleClientIds.length === 0) {
      if (status === 'NOT_ASSIGNED') {
        return {};
      }

      return { id: { in: [] } };
    }

    const visibleClientFilter =
      adminRole === Role.SUPER_ADMIN
        ? {}
        : { client_id: { in: visibleClientIds } };

    if (status === 'NOT_ASSIGNED') {
      return { clients: { none: visibleClientFilter } };
    }

    if (status === 'IN_PROGRESS') {
      return {
        clients: {
          some: {
            ...visibleClientFilter,
            is_completed: false,
          },
        },
      };
    }

    return {
      clients: {
        some: visibleClientFilter,
      },
      NOT: {
        clients: {
          some: {
            ...visibleClientFilter,
            is_completed: false,
          },
        },
      },
    };
  }

  private buildAdminChallengeWhere(
    adminId: string,
    adminRole: string,
    query: ChallengesQueryDto,
    visibleClientIds: string[],
  ): Prisma.ChallengeWhereInput {
    const baseWhere: Prisma.ChallengeWhereInput = {
      ...(adminRole === Role.ADMIN ? { created_by: adminId } : {}),
      ...(query.search
        ? {
            OR: [
              {
                title: {
                  contains: query.search,
                  mode: 'insensitive',
                },
              },
              {
                description: {
                  contains: query.search,
                  mode: 'insensitive',
                },
              },
            ],
          }
        : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.is_manual !== undefined ? { is_manual: query.is_manual } : {}),
      ...(query.is_global !== undefined ? { is_global: query.is_global } : {}),
    };

    if (!query.completion_status) {
      return baseWhere;
    }

    return {
      AND: [
        baseWhere,
        this.buildCompletionStatusWhere(
          query.completion_status,
          adminRole,
          visibleClientIds,
        ),
      ],
    };
  }

  private async assertChallengeAccess(
    challengeId: string,
    adminId: string,
    adminRole: string,
    prisma: PrismaClientLike = this.prisma,
  ) {
    const challenge = await prisma.challenge.findUnique({
      where: { id: challengeId },
      select: ADMIN_CHALLENGE_SELECT,
    });

    if (!challenge) {
      throw new NotFoundException('Challenge not found');
    }

    if (adminRole === Role.SUPER_ADMIN) {
      return challenge;
    }

    if (adminRole !== Role.ADMIN || challenge.created_by !== adminId) {
      throw new ForbiddenException('No tienes permisos sobre este reto');
    }

    return challenge;
  }

  private async assertClientIdsExist(
    clientIds: string[],
    prisma: PrismaClientLike = this.prisma,
  ) {
    if (clientIds.length === 0) {
      return;
    }

    const clients = await prisma.user.findMany({
      where: {
        id: { in: clientIds },
        role: Role.CLIENT,
      },
      select: { id: true },
    });

    if (clients.length !== clientIds.length) {
      throw new NotFoundException('Uno o más clientes no existen');
    }
  }

  private async resolveTargetClientIds(
    adminId: string,
    adminRole: string,
    dto: AssignChallengeDto,
    prisma: PrismaClientLike = this.prisma,
  ) {
    const visibleClientIds = await this.resolveVisibleClientIds(
      adminId,
      adminRole,
      prisma,
    );

    if (dto.apply_to_all_visible_clients) {
      return [...new Set(visibleClientIds)];
    }

    const requestedClientIds = [...new Set(dto.client_ids ?? [])];

    if (requestedClientIds.length === 0) {
      return [];
    }

    if (adminRole !== Role.SUPER_ADMIN) {
      const visibleClientSet = new Set(visibleClientIds);
      const inaccessibleClient = requestedClientIds.find(
        (clientId) => !visibleClientSet.has(clientId),
      );

      if (inaccessibleClient) {
        throw new ForbiddenException(
          'Uno o más clientes no están visibles para este admin',
        );
      }
    }

    await this.assertClientIdsExist(requestedClientIds, prisma);

    return requestedClientIds;
  }

  private async getAssignmentCountsByChallenge(
    challengeIds: string[],
    adminRole: string,
    visibleClientIds: string[],
  ) {
    if (challengeIds.length === 0) {
      return {
        assignedCounts: new Map<string, number>(),
        completedCounts: new Map<string, number>(),
      };
    }

    const clientScopeWhere = this.buildVisibleChallengeClientWhere(
      adminRole,
      visibleClientIds,
    );

    const [assignedGroups, completedGroups] = await Promise.all([
      this.prisma.challengeClient.groupBy({
        by: ['challenge_id'],
        where: {
          challenge_id: { in: challengeIds },
          ...clientScopeWhere,
        },
        _count: { _all: true },
      }),
      this.prisma.challengeClient.groupBy({
        by: ['challenge_id'],
        where: {
          challenge_id: { in: challengeIds },
          is_completed: true,
          ...clientScopeWhere,
        },
        _count: { _all: true },
      }),
    ]);

    return {
      assignedCounts: new Map(
        assignedGroups.map((group) => [group.challenge_id, group._count._all]),
      ),
      completedCounts: new Map(
        completedGroups.map((group) => [group.challenge_id, group._count._all]),
      ),
    };
  }

  private serializeChallenge(
    challenge: AdminChallengeRecord,
    assignedClients: number,
    completedClients: number,
  ) {
    return {
      ...challenge,
      assigned_clients: assignedClients,
      completed_clients: completedClients,
      completion_rate: this.calculateCompletionRate(
        assignedClients,
        completedClients,
      ),
    };
  }

  private serializeChallengeAssignment(
    assignment: ChallengeClientRecord,
    targetValue: number,
  ) {
    return {
      ...assignment,
      progress_rate:
        targetValue > 0
          ? Math.min(Math.round((assignment.current_value / targetValue) * 100), 100)
          : 0,
    };
  }

  private buildCreateChallengeData(
    adminId: string,
    dto: CreateChallengeDto,
  ): Prisma.ChallengeCreateInput {
    const isManual = dto.is_manual ?? true;

    if (!isManual && !dto.rule_key) {
      throw new BadRequestException(
        'Los retos automáticos requieren una regla explícita',
      );
    }

    return {
      title: dto.title,
      description: dto.description,
      type: dto.type,
      target_value: dto.target_value,
      unit: dto.unit,
      is_manual: isManual,
      is_global: dto.is_global ?? false,
      deadline: dto.deadline ? new Date(dto.deadline) : undefined,
      created_by: adminId,
      ...(isManual ? {} : { rule_key: dto.rule_key ?? null }),
      ...(!isManual && dto.rule_config !== undefined
        ? { rule_config: dto.rule_config as Prisma.InputJsonValue }
        : {}),
    };
  }

  private buildUpdateChallengeData(
    challenge: AdminChallengeRecord,
    dto: UpdateChallengeDto,
  ): Prisma.ChallengeUpdateInput {
    const isManual = dto.is_manual ?? challenge.is_manual;
    const nextRuleKey = dto.rule_key ?? challenge.rule_key;

    if (!isManual && !nextRuleKey) {
      throw new BadRequestException(
        'Los retos automáticos requieren una regla explícita',
      );
    }

    const data: Prisma.ChallengeUpdateInput = {
      ...(dto.title !== undefined ? { title: dto.title } : {}),
      ...(dto.description !== undefined ? { description: dto.description } : {}),
      ...(dto.type !== undefined ? { type: dto.type } : {}),
      ...(dto.target_value !== undefined ? { target_value: dto.target_value } : {}),
      ...(dto.unit !== undefined ? { unit: dto.unit } : {}),
      ...(dto.is_manual !== undefined ? { is_manual: dto.is_manual } : {}),
      ...(dto.is_global !== undefined ? { is_global: dto.is_global } : {}),
    };

    if (dto.deadline !== undefined) {
      data.deadline = dto.deadline ? new Date(dto.deadline) : null;
    }

    if (isManual) {
      data.rule_key = null;
      data.rule_config = Prisma.DbNull;
    } else {
      if (dto.rule_key !== undefined) {
        data.rule_key = dto.rule_key;
      }

      if (dto.rule_config !== undefined) {
        data.rule_config = dto.rule_config as Prisma.InputJsonValue;
      }
    }

    return data;
  }

  private async syncGlobalAssignments(
    challengeId: string,
    creatorScopeClientIds: string[],
    prisma: PrismaClientLike = this.prisma,
  ) {
    const targetClientIds = [...new Set(creatorScopeClientIds)];
    const targetClientIdSet = new Set(targetClientIds);
    const existingAssignments = await prisma.challengeClient.findMany({
      where: { challenge_id: challengeId },
      select: {
        client_id: true,
        assignment_source: true,
      },
    });
    const existingClientIdSet = new Set(
      existingAssignments.map((assignment) => assignment.client_id),
    );
    const clientIdsToCreate = targetClientIds.filter(
      (clientId) => !existingClientIdSet.has(clientId),
    );
    const globalClientIdsToDelete = existingAssignments
      .filter(
        (assignment) =>
          assignment.assignment_source ===
            ChallengeAssignmentSource.GLOBAL &&
          !targetClientIdSet.has(assignment.client_id),
      )
      .map((assignment) => assignment.client_id);

    if (clientIdsToCreate.length > 0) {
      await prisma.challengeClient.createMany({
        data: clientIdsToCreate.map((clientId) => ({
          challenge_id: challengeId,
          client_id: clientId,
          assignment_source: ChallengeAssignmentSource.GLOBAL,
          current_value: 0,
          is_completed: false,
        })),
        skipDuplicates: true,
      });
    }

    if (globalClientIdsToDelete.length > 0) {
      await prisma.challengeClient.deleteMany({
        where: {
          challenge_id: challengeId,
          client_id: { in: globalClientIdsToDelete },
          assignment_source: ChallengeAssignmentSource.GLOBAL,
        },
      });
    }
  }

  private async materializeGlobalAssignmentForClient(
    challengeId: string,
    clientId: string,
    prisma: PrismaClientLike = this.prisma,
  ) {
    const existingAssignment = await prisma.challengeClient.findUnique({
      where: {
        challenge_id_client_id: {
          challenge_id: challengeId,
          client_id: clientId,
        },
      },
      select: {
        assignment_source: true,
      },
    });

    if (existingAssignment) {
      return existingAssignment;
    }

    return prisma.challengeClient.create({
      data: {
        challenge_id: challengeId,
        client_id: clientId,
        assignment_source: ChallengeAssignmentSource.GLOBAL,
        current_value: 0,
        is_completed: false,
      },
      select: {
        assignment_source: true,
      },
    });
  }

  private async upsertManualAssignment(
    challengeId: string,
    clientId: string,
    prisma: PrismaClientLike = this.prisma,
  ) {
    await prisma.challengeClient.upsert({
      where: {
        challenge_id_client_id: {
          challenge_id: challengeId,
          client_id: clientId,
        },
      },
      create: {
        challenge_id: challengeId,
        client_id: clientId,
        assignment_source: ChallengeAssignmentSource.MANUAL,
        current_value: 0,
        is_completed: false,
      },
      update: {
        assignment_source: ChallengeAssignmentSource.MANUAL,
      },
    });
  }

  private async refreshManualAssignments(
    challengeId: string,
    targetValue: number,
    prisma: PrismaClientLike = this.prisma,
  ) {
    const assignments = await prisma.challengeClient.findMany({
      where: { challenge_id: challengeId },
      select: {
        challenge_id: true,
        client_id: true,
        current_value: true,
        completed_at: true,
      },
    });

    await Promise.all(
      assignments.map((assignment) => {
        const isCompleted = assignment.current_value >= targetValue;

        return prisma.challengeClient.update({
          where: {
            challenge_id_client_id: {
              challenge_id: assignment.challenge_id,
              client_id: assignment.client_id,
            },
          },
          data: {
            is_completed: isCompleted,
            completed_at: isCompleted
              ? assignment.completed_at ?? new Date()
              : null,
          },
        });
      }),
    );
  }

  private async getChallengeCounts(
    challengeId: string,
    prisma: PrismaClientLike = this.prisma,
  ) {
    const [assignedClients, completedClients] = await Promise.all([
      prisma.challengeClient.count({
        where: { challenge_id: challengeId },
      }),
      prisma.challengeClient.count({
        where: {
          challenge_id: challengeId,
          is_completed: true,
        },
      }),
    ]);

    return { assignedClients, completedClients };
  }

  private async serializeChallengeWithCurrentCounts(
    challenge: AdminChallengeRecord,
    prisma: PrismaClientLike = this.prisma,
  ) {
    const { assignedClients, completedClients } =
      await this.getChallengeCounts(challenge.id, prisma);

    return this.serializeChallenge(challenge, assignedClients, completedClients);
  }

  private evaluateAutomaticProgress(
    ruleKey: ChallengeRuleKey | null,
    assignedAt: Date,
    deadline: Date | null,
    dayProgress: Array<{
      date: Date;
      training_completed: boolean;
      meals_completed: string[];
    }>,
    bodyMetrics: Array<{
      date: Date;
      weight_kg: number | null;
    }>,
    streak: { current_days: number } | null,
  ) {
    const { start, end } = this.getChallengeWindow(assignedAt, deadline);

    switch (ruleKey) {
      case 'TRAINING_DAYS':
        return dayProgress.filter(
          (entry) =>
            entry.training_completed &&
            this.isDateInRange(entry.date, start, end),
        ).length;
      case 'MEAL_CHECKINS':
        return dayProgress.reduce((total, entry) => {
          if (!this.isDateInRange(entry.date, start, end)) {
            return total;
          }

          return total + entry.meals_completed.length;
        }, 0);
      case 'WEIGHT_LOGS': {
        const uniqueDays = new Set(
          bodyMetrics
            .filter(
              (entry) =>
                entry.weight_kg != null &&
                this.isDateInRange(entry.date, start, end),
            )
            .map((entry) => this.normalizeDate(entry.date).toISOString()),
        );

        return uniqueDays.size;
      }
      case 'STREAK_DAYS':
        return streak?.current_days ?? 0;
      default:
        return 0;
    }
  }

  async findAllForAdmin(
    adminId: string,
    adminRole: string,
    query: ChallengesQueryDto,
  ) {
    const visibleClientIds = await this.resolveVisibleClientIds(adminId, adminRole);
    const where = this.buildAdminChallengeWhere(
      adminId,
      adminRole,
      query,
      visibleClientIds,
    );

    const [challenges, total, totalWeekly, totalMainGoal, totalAutomatic, totalGlobal] =
      await Promise.all([
        this.prisma.challenge.findMany({
          where,
          orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
          skip: query.skip,
          take: query.limit,
          select: ADMIN_CHALLENGE_SELECT,
        }),
        this.prisma.challenge.count({ where }),
        this.prisma.challenge.count({ where: { AND: [where, { type: ChallengeType.WEEKLY }] } }),
        this.prisma.challenge.count({ where: { AND: [where, { type: ChallengeType.MAIN_GOAL }] } }),
        this.prisma.challenge.count({ where: { AND: [where, { is_manual: false }] } }),
        this.prisma.challenge.count({ where: { AND: [where, { is_global: true }] } }),
      ]);

    const challengeIds = challenges.map((challenge) => challenge.id);
    const { assignedCounts, completedCounts } =
      await this.getAssignmentCountsByChallenge(
        challengeIds,
        adminRole,
        visibleClientIds,
      );

    return {
      ...paginate(
        challenges.map((challenge) => {
          const assignedClients = assignedCounts.get(challenge.id) ?? 0;
          const completedClients = completedCounts.get(challenge.id) ?? 0;

          return this.serializeChallenge(
            challenge,
            assignedClients,
            completedClients,
          );
        }),
        total,
        query,
      ),
      summary: {
        total,
        weekly: totalWeekly,
        main_goal: totalMainGoal,
        automatic: totalAutomatic,
        global: totalGlobal,
      },
    };
  }

  async findOneForAdmin(
    id: string,
    adminId: string,
    adminRole: string,
    query: ChallengeAssignmentsQueryDto,
  ) {
    const [challenge, visibleClientIds] = await Promise.all([
      this.assertChallengeAccess(id, adminId, adminRole),
      this.resolveVisibleClientIds(adminId, adminRole),
    ]);

    if (
      query.client_id &&
      adminRole !== Role.SUPER_ADMIN &&
      !visibleClientIds.includes(query.client_id)
    ) {
      throw new ForbiddenException('Este cliente no está visible para este admin');
    }

    const clientScopeWhere = this.buildVisibleChallengeClientWhere(
      adminRole,
      visibleClientIds,
    );
    const assignmentsWhere: Prisma.ChallengeClientWhereInput = {
      challenge_id: id,
      ...clientScopeWhere,
      ...(query.client_id ? { client_id: query.client_id } : {}),
      ...(query.is_completed !== undefined
        ? { is_completed: query.is_completed }
        : {}),
    };
    const summaryWhere: Prisma.ChallengeClientWhereInput = {
      challenge_id: id,
      ...clientScopeWhere,
    };

    const [assignments, total, assignedClients, completedClients] = await Promise.all([
      this.prisma.challengeClient.findMany({
        where: assignmentsWhere,
        orderBy: [{ is_completed: 'asc' }, { assigned_at: 'desc' }],
        skip: query.skip,
        take: query.limit,
        select: CHALLENGE_CLIENT_SELECT,
      }),
      this.prisma.challengeClient.count({ where: assignmentsWhere }),
      this.prisma.challengeClient.count({ where: summaryWhere }),
      this.prisma.challengeClient.count({
        where: {
          ...summaryWhere,
          is_completed: true,
        },
      }),
    ]);

    return {
      ...this.serializeChallenge(challenge, assignedClients, completedClients),
      assignments: paginate(
        assignments.map((assignment) =>
          this.serializeChallengeAssignment(
            assignment,
            challenge.target_value,
          ),
        ),
        total,
        query,
      ),
    };
  }

  async findMyChallenges(clientId: string) {
    await this.recalculateAutomaticProgress(clientId);
    await this.evaluateAchievementsForClient(clientId);

    return this.prisma.challengeClient.findMany({
      where: { client_id: clientId },
      include: { challenge: true },
      orderBy: { assigned_at: 'desc' },
    });
  }

  async create(adminId: string, adminRole: string, dto: CreateChallengeDto) {
    return this.prisma.$transaction(async (tx) => {
      const challenge = await tx.challenge.create({
        data: this.buildCreateChallengeData(adminId, dto),
        select: ADMIN_CHALLENGE_SELECT,
      });

      if (challenge.is_global) {
        const visibleClientIds = await this.resolveVisibleClientIds(
          adminId,
          adminRole,
          tx,
        );

        await this.syncGlobalAssignments(challenge.id, visibleClientIds, tx);

        if (!challenge.is_manual) {
          await Promise.all(
            visibleClientIds.map((clientId) =>
              this.recalculateAutomaticProgress(clientId, tx, [challenge.id]),
            ),
          );
          await Promise.all(
            visibleClientIds.map((clientId) =>
              this.evaluateAchievementsForClient(clientId, tx),
            ),
          );
        }
      }

      if (challenge.is_manual) {
        await this.refreshManualAssignments(
          challenge.id,
          challenge.target_value,
          tx,
        );

        if (challenge.is_global) {
          const assignedClientIds = await this.getAssignedClientIds(challenge.id, tx);
          await Promise.all(
            assignedClientIds.map((clientId) =>
              this.evaluateAchievementsForClient(clientId, tx),
            ),
          );
        }
      }

      return this.serializeChallengeWithCurrentCounts(challenge, tx);
    });
  }

  async update(
    id: string,
    adminId: string,
    adminRole: string,
    dto: UpdateChallengeDto,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const challenge = await this.assertChallengeAccess(id, adminId, adminRole, tx);
      const updatedChallenge = await tx.challenge.update({
        where: { id },
        data: this.buildUpdateChallengeData(challenge, dto),
        select: ADMIN_CHALLENGE_SELECT,
      });

      const creatorScopeClientIds = updatedChallenge.is_global
        ? await this.resolveChallengeCreatorScope(updatedChallenge, tx)
        : [];

      await this.syncGlobalAssignments(id, creatorScopeClientIds, tx);

      if (updatedChallenge.is_manual) {
        await this.refreshManualAssignments(id, updatedChallenge.target_value, tx);
        const assignedClientIds = await this.getAssignedClientIds(id, tx);
        await Promise.all(
          assignedClientIds.map((clientId) =>
            this.evaluateAchievementsForClient(clientId, tx),
          ),
        );
      } else {
        const assignmentClientIds = await this.getAssignedClientIds(id, tx);

        await Promise.all(
          assignmentClientIds.map((clientId) =>
            this.recalculateAutomaticProgress(clientId, tx, [id]),
          ),
        );
        await Promise.all(
          assignmentClientIds.map((clientId) =>
            this.evaluateAchievementsForClient(clientId, tx),
          ),
        );
      }

      return this.serializeChallengeWithCurrentCounts(updatedChallenge, tx);
    });
  }

  async assignToClients(
    challengeId: string,
    adminId: string,
    adminRole: string,
    dto: AssignChallengeDto,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const challenge = await this.assertChallengeAccess(
        challengeId,
        adminId,
        adminRole,
        tx,
      );
      const clientIds = await this.resolveTargetClientIds(
        adminId,
        adminRole,
        dto,
        tx,
      );

      if (clientIds.length === 0) {
        throw new BadRequestException('No hay clientes visibles para asignar');
      }

      await Promise.all(
        clientIds.map((clientId) =>
          this.upsertManualAssignment(challengeId, clientId, tx),
        ),
      );

      if (challenge.is_manual) {
        await this.refreshManualAssignments(challengeId, challenge.target_value, tx);
        await Promise.all(
          clientIds.map((clientId) =>
            this.evaluateAchievementsForClient(clientId, tx),
          ),
        );
      } else {
        await Promise.all(
          clientIds.map((clientId) =>
            this.recalculateAutomaticProgress(clientId, tx, [challengeId]),
          ),
        );
        await Promise.all(
          clientIds.map((clientId) =>
            this.evaluateAchievementsForClient(clientId, tx),
          ),
        );
      }

      return {
        challenge_id: challengeId,
        assigned_clients: clientIds.length,
      };
    });
  }

  async remove(id: string, adminId: string, adminRole: string) {
    await this.assertChallengeAccess(id, adminId, adminRole);

    await this.prisma.challenge.delete({ where: { id } });

    return { message: 'Reto eliminado correctamente' };
  }

  async syncGlobalChallengesForCreatorClient(
    creatorId: string,
    clientId: string,
    prisma: PrismaClientLike = this.prisma,
  ) {
    const creator = await prisma.user.findUnique({
      where: { id: creatorId },
      select: { id: true, role: true },
    });

    if (
      !creator ||
      (creator.role !== Role.ADMIN && creator.role !== Role.SUPER_ADMIN)
    ) {
      return;
    }

    const creatorScopeClientIds = await this.resolveVisibleClientIds(
      creator.id,
      creator.role,
      prisma,
    );
    const creatorScopeClientIdSet = new Set(creatorScopeClientIds);
    const globalChallenges = await prisma.challenge.findMany({
      where: {
        created_by: creator.id,
        is_global: true,
      },
      select: {
        id: true,
        is_manual: true,
        target_value: true,
      },
    });

    if (globalChallenges.length === 0) {
      return;
    }

    if (!creatorScopeClientIdSet.has(clientId)) {
      await prisma.challengeClient.deleteMany({
        where: {
          client_id: clientId,
          assignment_source: ChallengeAssignmentSource.GLOBAL,
          challenge_id: { in: globalChallenges.map((challenge) => challenge.id) },
        },
      });

      return;
    }

    await Promise.all(
      globalChallenges.map((challenge) =>
        this.materializeGlobalAssignmentForClient(challenge.id, clientId, prisma),
      ),
    );

    const automaticChallengeIds = globalChallenges
      .filter((challenge) => !challenge.is_manual)
      .map((challenge) => challenge.id);

    if (automaticChallengeIds.length > 0) {
      await this.recalculateAutomaticProgress(clientId, prisma, automaticChallengeIds);
    }

    const manualChallenges = globalChallenges.filter((challenge) => challenge.is_manual);

    await Promise.all(
      manualChallenges.map((challenge) =>
        this.refreshManualAssignments(challenge.id, challenge.target_value, prisma),
      ),
    );

    await this.evaluateAchievementsForClient(clientId, prisma);
  }

  async recalculateAutomaticProgress(
    clientId: string,
    prisma: PrismaClientLike = this.prisma,
    challengeIds?: string[],
  ) {
    const assignments = await prisma.challengeClient.findMany({
      where: {
        client_id: clientId,
        challenge: {
          is_manual: false,
          ...(challengeIds?.length ? { id: { in: challengeIds } } : {}),
        },
      },
      include: {
        challenge: {
          select: {
            id: true,
            target_value: true,
            rule_key: true,
            deadline: true,
          },
        },
      },
    });

    if (assignments.length === 0) {
      return;
    }

    const earliestAssignedAt = assignments.reduce((currentEarliest, assignment) => {
      const assignedAt = this.normalizeDate(assignment.assigned_at);

      if (!currentEarliest || assignedAt.getTime() < currentEarliest.getTime()) {
        return assignedAt;
      }

      return currentEarliest;
    }, null as Date | null);

    if (!earliestAssignedAt) {
      return;
    }

    const [dayProgress, bodyMetrics, streak] = await Promise.all([
      prisma.dayProgress.findMany({
        where: {
          client_id: clientId,
          date: { gte: earliestAssignedAt },
        },
        select: {
          date: true,
          training_completed: true,
          meals_completed: true,
        },
      }),
      prisma.bodyMetric.findMany({
        where: {
          client_id: clientId,
          date: { gte: earliestAssignedAt },
        },
        select: {
          date: true,
          weight_kg: true,
        },
      }),
      prisma.streak.findUnique({
        where: { client_id: clientId },
        select: { current_days: true },
      }),
    ]);

    await Promise.all(
      assignments.map((assignment) => {
        const currentValue = this.evaluateAutomaticProgress(
          assignment.challenge.rule_key as ChallengeRuleKey | null,
          assignment.assigned_at,
          assignment.challenge.deadline,
          dayProgress,
          bodyMetrics,
          streak,
        );
        const isCompleted = currentValue >= assignment.challenge.target_value;

        return prisma.challengeClient.update({
          where: {
            challenge_id_client_id: {
              challenge_id: assignment.challenge_id,
              client_id: assignment.client_id,
            },
          },
          data: {
            current_value: currentValue,
            is_completed: isCompleted,
            completed_at: isCompleted
              ? assignment.completed_at ?? new Date()
              : null,
          },
        });
      }),
    );
  }

  async updateProgress(
    clientId: string,
    challengeId: string,
    dto: UpdateProgressDto,
  ) {
    const record = await this.prisma.challengeClient.findUnique({
      where: {
        challenge_id_client_id: {
          challenge_id: challengeId,
          client_id: clientId,
        },
      },
      include: { challenge: true },
    });

    if (!record) {
      throw new NotFoundException('Challenge assignment not found');
    }

    if (!record.challenge.is_manual) {
      throw new ForbiddenException(
        'Los retos automáticos se recalculan desde el backend',
      );
    }

    const isCompleted = dto.current_value >= record.challenge.target_value;

    const updatedRecord = await this.prisma.challengeClient.update({
      where: {
        challenge_id_client_id: {
          challenge_id: challengeId,
          client_id: clientId,
        },
      },
      data: {
        current_value: dto.current_value,
        is_completed: isCompleted,
        completed_at: isCompleted
          ? record.completed_at ?? new Date()
          : null,
      },
    });

    await this.evaluateAchievementsForClient(clientId);

    return updatedRecord;
  }
}
