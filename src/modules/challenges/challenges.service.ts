import {
  calculateStreak,
  evaluateAutomaticProgress,
  normalizeDate,
} from './challenge-progress';
import { AggregateRule } from '../../common/progress/aggregate-scope';
import {
  lockClientDayProgress,
  lockClientsDayProgress,
} from '../../common/progress/day-progress-lock';
import type {
  ChallengeEligibilityPeriod,
  StreakProgress,
} from './challenge-progress';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
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
import { NotificationsService } from '../notifications/notifications.service';
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

const ELIGIBILITY_PERIOD_SELECT = {
  starts_on: true,
  ends_on: true,
  opened_at: true,
  baseline_value: true,
} as const;

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

type ChallengeNotificationData = {
  id: string;
  title: string;
  created_by?: string | null;
};

@Injectable()
export class ChallengesService {
  private readonly logger = new Logger(ChallengesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly achievementsService: AchievementsService,
    private readonly notifications: NotificationsService,
  ) {}

  private async evaluateAchievementsForClient(
    clientId: string,
    prisma: PrismaClientLike = this.prisma,
  ) {
    await this.achievementsService.evaluateAutomaticAchievementsForUser(
      clientId,
      prisma,
      undefined,
      ['CHALLENGES_COMPLETED'],
    );
  }

  private async resolveNotificationSender(
    senderId: string | null | undefined,
    recipientId: string,
  ) {
    return senderId ?? this.notifications.findSystemSenderId(recipientId);
  }

  private isBeforeToday(date: Date) {
    return normalizeDate(date).getTime() < normalizeDate(new Date()).getTime();
  }

  private assertDeadlineIsAssignable(
    deadline: Date | string | null | undefined,
  ) {
    if (!deadline) {
      return;
    }

    const deadlineDate =
      deadline instanceof Date ? deadline : new Date(deadline);

    if (this.isBeforeToday(deadlineDate)) {
      throw new BadRequestException(
        'La fecha límite del reto no puede estar vencida',
      );
    }
  }

  private calculateCompletionRate(
    assignedClients: number,
    completedClients: number,
  ) {
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
      return [];
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
    adminId: string,
  ): Prisma.ChallengeClientWhereInput {
    if (adminRole === Role.SUPER_ADMIN) return {};
    if (adminRole === Role.ADMIN)
      return {
        client: {
          is: { clientOf: { some: { admin_id: adminId, is_active: true } } },
        },
      };
    return { client_id: { in: [] } };
  }

  private buildCompletionStatusWhere(
    status: ChallengeCompletionStatus,
    visibleClientFilter: Prisma.ChallengeClientWhereInput,
  ): Prisma.ChallengeWhereInput {
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
    visibleClientFilter: Prisma.ChallengeClientWhereInput,
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
          visibleClientFilter,
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
    clientScopeWhere: Prisma.ChallengeClientWhereInput,
  ) {
    if (challengeIds.length === 0) {
      return {
        assignedCounts: new Map<string, number>(),
        completedCounts: new Map<string, number>(),
      };
    }

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
          ? Math.min(
              Math.round((assignment.current_value / targetValue) * 100),
              100,
            )
          : 0,
    };
  }

  private buildCreateChallengeData(
    adminId: string,
    dto: CreateChallengeDto,
  ): Prisma.ChallengeCreateInput {
    const isManual = dto.is_manual ?? true;
    this.assertDeadlineIsAssignable(dto.deadline);

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

    if (dto.deadline !== undefined) {
      this.assertDeadlineIsAssignable(dto.deadline);
    }

    if (!isManual && !nextRuleKey) {
      throw new BadRequestException(
        'Los retos automáticos requieren una regla explícita',
      );
    }

    const data: Prisma.ChallengeUpdateInput = {
      ...(dto.title !== undefined ? { title: dto.title } : {}),
      ...(dto.description !== undefined
        ? { description: dto.description }
        : {}),
      ...(dto.type !== undefined ? { type: dto.type } : {}),
      ...(dto.target_value !== undefined
        ? { target_value: dto.target_value }
        : {}),
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
    lockedClientIds?: Set<string>,
  ) {
    const targetClientIds = [...new Set(creatorScopeClientIds)];
    const targetClientIdSet = new Set(targetClientIds);
    const [, existingAssignments] = await Promise.all([
      prisma.challenge.findUnique({
        where: { id: challengeId },
        select: { id: true, title: true, created_by: true },
      }),
      prisma.challengeClient.findMany({
        where: { challenge_id: challengeId },
        select: {
          id: true,
          client_id: true,
          assignment_source: true,
          assigned_at: true,
          current_value: true,
          eligibility_periods: {
            select: ELIGIBILITY_PERIOD_SELECT,
          },
        },
      }),
    ]);
    const existingClientIdSet = new Set(
      existingAssignments.map((assignment) => assignment.client_id),
    );
    const clientIdsToCreate = targetClientIds.filter(
      (clientId) => !existingClientIdSet.has(clientId),
    );
    const clientIdsToLock = [...targetClientIds, ...existingClientIdSet];
    if (lockedClientIds)
      this.assertLockedClientScope(clientIdsToLock, lockedClientIds);
    await lockClientsDayProgress(prisma, clientIdsToLock);
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

    const globalAssignments = await prisma.challengeClient.findMany({
      where: {
        challenge_id: challengeId,
        assignment_source: ChallengeAssignmentSource.GLOBAL,
      },
      select: {
        id: true,
        client_id: true,
        assigned_at: true,
        current_value: true,
        eligibility_periods: { select: ELIGIBILITY_PERIOD_SELECT },
      },
    });
    await this.syncGlobalEligibilityPeriods(
      globalAssignments,
      targetClientIdSet,
      prisma,
    );
  }

  private async syncGlobalEligibilityPeriods(
    assignments: Array<{
      id: string;
      client_id: string;
      assigned_at: Date;
      current_value: number;
      eligibility_periods: ChallengeEligibilityPeriod[];
    }>,
    eligibleClientIds: Set<string>,
    prisma: PrismaClientLike,
  ) {
    if (assignments.length === 0) return;
    const clientIds = [
      ...new Set(assignments.map((assignment) => assignment.client_id)),
    ].sort();
    // Match scope-trigger ordering before re-reading both the scope and period baseline.
    await prisma.$queryRaw(Prisma.sql`SELECT id FROM challenge_clients
      WHERE client_id IN (${Prisma.join(clientIds)}) AND assignment_source = 'GLOBAL'
      ORDER BY client_id, id FOR UPDATE`);
    const currentAssignments = await prisma.challengeClient.findMany({
      where: {
        id: { in: assignments.map((assignment) => assignment.id) },
        assignment_source: ChallengeAssignmentSource.GLOBAL,
      },
      select: {
        id: true,
        challenge_id: true,
        client_id: true,
        assigned_at: true,
        current_value: true,
        eligibility_periods: { select: ELIGIBILITY_PERIOD_SELECT },
      },
    });
    const eligibleAssignmentIds = new Set<string>();
    for (const clientId of clientIds) {
      if (!eligibleClientIds.has(clientId)) continue;
      const challengeIds = new Set(
        await this.eligibleGlobalChallengeIds(clientId, prisma),
      );
      for (const assignment of currentAssignments) {
        if (
          assignment.client_id === clientId &&
          challengeIds.has(assignment.challenge_id)
        )
          eligibleAssignmentIds.add(assignment.id);
      }
    }
    assignments = currentAssignments;
    const today = normalizeDate(new Date());
    const tomorrow = new Date(today);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const inactiveIds = assignments
      .filter((assignment) => !eligibleAssignmentIds.has(assignment.id))
      .map((assignment) => assignment.id);

    const inactiveLegacyPeriods = assignments
      .filter(
        (assignment) =>
          !eligibleAssignmentIds.has(assignment.id) &&
          assignment.eligibility_periods.length === 0,
      )
      .map((assignment) => ({
        challenge_client_id: assignment.id,
        starts_on: today,
        ends_on: today,
        baseline_value: assignment.current_value,
      }));
    if (inactiveLegacyPeriods.length > 0) {
      await prisma.challengeClientEligibilityPeriod.createMany({
        data: inactiveLegacyPeriods,
        skipDuplicates: true,
      });
    }

    if (inactiveIds.length > 0) {
      for (const assignment of assignments.filter((row) =>
        inactiveIds.includes(row.id),
      )) {
        const open = assignment.eligibility_periods.find(
          (period) => period.ends_on === null,
        );
        await prisma.challengeClientEligibilityPeriod.updateMany({
          where: { challenge_client_id: assignment.id, ends_on: null },
          data: {
            ends_on: open && open.starts_on > today ? open.starts_on : today,
          },
        });
      }
    }

    const periodsToOpen = assignments.flatMap((assignment) => {
      if (
        !eligibleAssignmentIds.has(assignment.id) ||
        assignment.eligibility_periods.some((period) => period.ends_on === null)
      )
        return [];

      // Date-only activity cannot distinguish a same-day re-entry from work
      // performed while ineligible, so resume on the following UTC day.
      return [
        {
          challenge_client_id: assignment.id,
          starts_on: tomorrow,
          baseline_value: assignment.current_value,
        },
      ];
    });
    if (periodsToOpen.length > 0) {
      await prisma.challengeClientEligibilityPeriod.createMany({
        data: periodsToOpen,
        skipDuplicates: true,
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
        id: true,
        client_id: true,
        assignment_source: true,
        assigned_at: true,
        current_value: true,
        eligibility_periods: { select: ELIGIBILITY_PERIOD_SELECT },
      },
    });

    if (existingAssignment) {
      if (
        existingAssignment.assignment_source ===
        ChallengeAssignmentSource.GLOBAL
      ) {
        await this.syncGlobalEligibilityPeriods(
          [existingAssignment],
          new Set([clientId]),
          prisma,
        );
      }
      return existingAssignment;
    }

    const [, createdAssignment] = await Promise.all([
      prisma.challenge.findUnique({
        where: { id: challengeId },
        select: { id: true, title: true, created_by: true },
      }),
      prisma.challengeClient.create({
        data: {
          challenge_id: challengeId,
          client_id: clientId,
          assignment_source: ChallengeAssignmentSource.GLOBAL,
          current_value: 0,
          is_completed: false,
        },
        select: {
          id: true,
          client_id: true,
          assignment_source: true,
          assigned_at: true,
          current_value: true,
          eligibility_periods: { select: ELIGIBILITY_PERIOD_SELECT },
        },
      }),
    ]);

    await this.syncGlobalEligibilityPeriods(
      [createdAssignment],
      new Set([clientId]),
      prisma,
    );
    return createdAssignment;
  }

  private async upsertManualAssignment(
    challenge: ChallengeNotificationData,
    clientId: string,
    senderId: string,
    prisma: PrismaClientLike = this.prisma,
  ) {
    await prisma.challengeClient.upsert({
      where: {
        challenge_id_client_id: {
          challenge_id: challenge.id,
          client_id: clientId,
        },
      },
      create: {
        challenge_id: challenge.id,
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
    const [, assignments] = await Promise.all([
      prisma.challenge.findUnique({
        where: { id: challengeId },
        select: { id: true, title: true, created_by: true },
      }),
      prisma.challengeClient.findMany({
        where: { challenge_id: challengeId },
        select: {
          challenge_id: true,
          client_id: true,
          current_value: true,
          is_completed: true,
          completed_at: true,
        },
      }),
    ]);

    await Promise.all(
      assignments.map(async (assignment) => {
        const isCompleted = assignment.current_value >= targetValue;

        await prisma.challengeClient.update({
          where: {
            challenge_id_client_id: {
              challenge_id: assignment.challenge_id,
              client_id: assignment.client_id,
            },
          },
          data: {
            is_completed: isCompleted,
            completed_at: isCompleted
              ? (assignment.completed_at ?? new Date())
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
    const { assignedClients, completedClients } = await this.getChallengeCounts(
      challenge.id,
      prisma,
    );

    return this.serializeChallenge(
      challenge,
      assignedClients,
      completedClients,
    );
  }

  async findAllForAdmin(
    adminId: string,
    adminRole: string,
    query: ChallengesQueryDto,
  ) {
    const visibleClientFilter = this.buildVisibleChallengeClientWhere(
      adminRole,
      adminId,
    );
    const where = this.buildAdminChallengeWhere(
      adminId,
      adminRole,
      query,
      visibleClientFilter,
    );

    const [
      challenges,
      total,
      totalWeekly,
      totalMainGoal,
      totalAutomatic,
      totalGlobal,
    ] = await Promise.all([
      this.prisma.challenge.findMany({
        where,
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        skip: query.skip,
        take: query.limit,
        select: ADMIN_CHALLENGE_SELECT,
      }),
      this.prisma.challenge.count({ where }),
      this.prisma.challenge.count({
        where: { AND: [where, { type: ChallengeType.WEEKLY }] },
      }),
      this.prisma.challenge.count({
        where: { AND: [where, { type: ChallengeType.MAIN_GOAL }] },
      }),
      this.prisma.challenge.count({
        where: { AND: [where, { is_manual: false }] },
      }),
      this.prisma.challenge.count({
        where: { AND: [where, { is_global: true }] },
      }),
    ]);

    const challengeIds = challenges.map((challenge) => challenge.id);
    const { assignedCounts, completedCounts } =
      await this.getAssignmentCountsByChallenge(
        challengeIds,
        visibleClientFilter,
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
    const challenge = await this.assertChallengeAccess(id, adminId, adminRole);
    if (
      query.client_id &&
      adminRole !== Role.SUPER_ADMIN &&
      !(await this.prisma.adminClientAssignment.count({
        where: {
          admin_id: adminId,
          client_id: query.client_id,
          is_active: true,
        },
      }))
    ) {
      throw new ForbiddenException(
        'Este cliente no está visible para este admin',
      );
    }
    const clientScopeWhere = this.buildVisibleChallengeClientWhere(
      adminRole,
      adminId,
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

    const [assignments, total, assignedClients, completedClients] =
      await Promise.all([
        this.prisma.challengeClient.findMany({
          where: assignmentsWhere,
          orderBy: [
            { is_completed: 'asc' },
            { assigned_at: 'desc' },
            { id: 'desc' },
          ],
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
          this.serializeChallengeAssignment(assignment, challenge.target_value),
        ),
        total,
        query,
      ),
    };
  }

  async findMyChallenges(clientId: string) {
    const globalIds = await this.eligibleGlobalChallengeIds(
      clientId,
      this.prisma,
    );
    return this.prisma.challengeClient.findMany({
      where: {
        client_id: clientId,
        OR: [
          { assignment_source: ChallengeAssignmentSource.MANUAL },
          {
            challenge_id: { in: globalIds },
            eligibility_periods: { some: { ends_on: null } },
          },
        ],
      },
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
          const assignedClientIds = await this.getAssignedClientIds(
            challenge.id,
            tx,
          );
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
      let challenge = await this.assertChallengeAccess(
        id,
        adminId,
        adminRole,
        tx,
      );
      const [scopeAssignments, creatorScope] = await Promise.all([
        tx.challengeClient.findMany({
          where: {
            OR: [
              { challenge_id: id },
              {
                assignment_source: ChallengeAssignmentSource.GLOBAL,
                ...(challenge.created_by
                  ? { challenge: { created_by: challenge.created_by } }
                  : {}),
              },
            ],
          },
          select: { client_id: true },
        }),
        this.resolveChallengeCreatorScope(challenge, tx),
      ]);
      // The scope trigger takes assignment rows; acquire its entire daily lockset first.
      const lockedClientIds = new Set([
        ...scopeAssignments.map((assignment) => assignment.client_id),
        ...creatorScope,
      ]);
      await lockClientsDayProgress(tx, lockedClientIds);
      const currentChallenge = await this.assertChallengeAccess(
        id,
        adminId,
        adminRole,
        tx,
      );
      if (currentChallenge.created_by !== challenge.created_by)
        throw new ConflictException(
          'El ámbito del reto ha cambiado; vuelve a intentar la actualización',
        );
      challenge = currentChallenge;
      const updatedChallenge = await tx.challenge.update({
        where: { id },
        data: this.buildUpdateChallengeData(challenge, dto),
        select: ADMIN_CHALLENGE_SELECT,
      });
      if (updatedChallenge.created_by !== challenge.created_by)
        throw new ConflictException(
          'El ámbito del reto ha cambiado; vuelve a intentar la actualización',
        );

      const creatorScopeClientIds = updatedChallenge.is_global
        ? await this.resolveChallengeCreatorScope(updatedChallenge, tx)
        : [];

      await this.syncGlobalAssignments(
        id,
        creatorScopeClientIds,
        tx,
        lockedClientIds,
      );

      const assignedClientIds = await this.getAssignedClientIds(id, tx);
      this.assertLockedClientScope(assignedClientIds, lockedClientIds);

      if (updatedChallenge.is_manual) {
        await this.refreshManualAssignments(
          id,
          updatedChallenge.target_value,
          tx,
        );
        await Promise.all(
          assignedClientIds.map((clientId) =>
            this.evaluateAchievementsForClient(clientId, tx),
          ),
        );
      } else {
        await Promise.all(
          assignedClientIds.map((clientId) =>
            this.recalculateAutomaticProgress(clientId, tx, [id]),
          ),
        );
        await Promise.all(
          assignedClientIds.map((clientId) =>
            this.evaluateAchievementsForClient(clientId, tx),
          ),
        );
      }

      return this.serializeChallengeWithCurrentCounts(updatedChallenge, tx);
    });
  }

  private assertLockedClientScope(
    clientIds: string[],
    lockedClientIds: Set<string>,
  ) {
    if (clientIds.some((clientId) => !lockedClientIds.has(clientId)))
      throw new ConflictException(
        'El ámbito del reto ha cambiado; vuelve a intentar la actualización',
      );
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
      this.assertDeadlineIsAssignable(challenge.deadline);

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
          this.upsertManualAssignment(challenge, clientId, adminId, tx),
        ),
      );

      if (challenge.is_manual) {
        await this.refreshManualAssignments(
          challengeId,
          challenge.target_value,
          tx,
        );
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
  ): Promise<void> {
    if (prisma === this.prisma)
      return this.prisma.$transaction(async (tx) => {
        await lockClientDayProgress(tx, clientId);
        return this.syncGlobalChallengesForCreatorClient(
          creatorId,
          clientId,
          tx,
        );
      });
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
      const assignments = await prisma.challengeClient.findMany({
        where: {
          client_id: clientId,
          assignment_source: ChallengeAssignmentSource.GLOBAL,
          challenge_id: {
            in: globalChallenges.map((challenge) => challenge.id),
          },
        },
        select: {
          id: true,
          client_id: true,
          assigned_at: true,
          current_value: true,
          eligibility_periods: { select: ELIGIBILITY_PERIOD_SELECT },
        },
      });
      await this.syncGlobalEligibilityPeriods(assignments, new Set(), prisma);

      return;
    }

    await Promise.all(
      globalChallenges.map((challenge) =>
        this.materializeGlobalAssignmentForClient(
          challenge.id,
          clientId,
          prisma,
        ),
      ),
    );

    const automaticChallengeIds = globalChallenges
      .filter((challenge) => !challenge.is_manual)
      .map((challenge) => challenge.id);

    if (automaticChallengeIds.length > 0) {
      await this.recalculateAutomaticProgress(
        clientId,
        prisma,
        automaticChallengeIds,
      );
    }

    const manualChallenges = globalChallenges.filter(
      (challenge) => challenge.is_manual,
    );

    await Promise.all(
      manualChallenges.map((challenge) =>
        this.refreshManualAssignments(
          challenge.id,
          challenge.target_value,
          prisma,
        ),
      ),
    );

    await this.evaluateAchievementsForClient(clientId, prisma);
  }

  async recalculateAutomaticProgress(
    clientId: string,
    prisma: PrismaClientLike = this.prisma,
    challengeIds?: string[],
    rules?: AggregateRule[],
    asOf = new Date(),
  ): Promise<void> {
    if (prisma === this.prisma) {
      return this.prisma.$transaction(
        async (tx) => {
          await lockClientDayProgress(tx, clientId);
          return this.recalculateAutomaticProgress(
            clientId,
            tx,
            challengeIds,
            rules,
            asOf,
          );
        },
        { maxWait: 5000, timeout: 30000 },
      );
    }
    const globalIds = await this.eligibleGlobalChallengeIds(
      clientId,
      prisma,
      true,
    );
    const assignments = await prisma.challengeClient.findMany({
      where: {
        client_id: clientId,
        OR: [
          { assignment_source: ChallengeAssignmentSource.MANUAL },
          {
            challenge_id: { in: globalIds },
            eligibility_periods: { some: { ends_on: null } },
          },
        ],
        challenge: {
          is_manual: false,
          ...(rules && { rule_key: { in: rules } }),
          ...(challengeIds?.length ? { id: { in: challengeIds } } : {}),
        },
      },
      include: {
        eligibility_periods: {
          select: ELIGIBILITY_PERIOD_SELECT,
          orderBy: { starts_on: 'asc' },
        },
        challenge: {
          select: {
            id: true,
            target_value: true,
            rule_key: true,
            deadline: true,
            title: true,
            created_by: true,
          },
        },
      },
    });

    if (assignments.length === 0) {
      return;
    }

    const earliestAssignedAt = assignments.reduce(
      (currentEarliest, assignment) => {
        const assignedAt = normalizeDate(assignment.assigned_at);

        if (
          !currentEarliest ||
          assignedAt.getTime() < currentEarliest.getTime()
        ) {
          return assignedAt;
        }

        return currentEarliest;
      },
      null as Date | null,
    );

    if (!earliestAssignedAt) {
      return;
    }

    const needed = new Set(assignments.map((a) => a.challenge.rule_key));
    const needsProvenance = assignments.some(
      (a) => a.assignment_source === ChallengeAssignmentSource.GLOBAL,
    );
    const [dayProgress, bodyMetrics, streak, streakAssignments] =
      await Promise.all([
        needed.has('TRAINING_DAYS') ||
        needed.has('MEAL_CHECKINS') ||
        needed.has('STREAK_DAYS')
          ? needsProvenance
            ? prisma.$queryRaw<StreakProgress[]>(Prisma.sql`
              SELECT date, training_completed, exercises_completed, COALESCE(meals_completed, ARRAY[]::text[]) AS meals_completed, updated_at,
                (challenge_activity->>'training')::timestamptz AS training_recorded_at,
                COALESCE(challenge_activity->'exercises', '[]'::jsonb) AS exercise_activity,
                COALESCE(challenge_activity->'meals', '{}'::jsonb) AS meal_recorded_at
              FROM day_progress WHERE client_id = ${clientId} AND date >= ${earliestAssignedAt}
            `)
            : prisma.dayProgress.findMany({
                where: {
                  client_id: clientId,
                  date: { gte: earliestAssignedAt },
                },
                select: {
                  date: true,
                  training_completed: true,
                  exercises_completed: true,
                  meals_completed: true,
                  updated_at: true,
                },
              })
          : [],
        needed.has('WEIGHT_LOGS')
          ? needsProvenance
            ? prisma.$queryRaw<
                Array<{
                  date: Date;
                  weight_kg: number | null;
                  recorded_at: Date | null;
                }>
              >(Prisma.sql`
              SELECT date, weight_kg, challenge_activity_at AS recorded_at FROM body_metrics
              WHERE client_id = ${clientId} AND date >= ${earliestAssignedAt}
            `)
            : prisma.bodyMetric.findMany({
                where: {
                  client_id: clientId,
                  date: { gte: earliestAssignedAt },
                },
                select: {
                  date: true,
                  weight_kg: true,
                },
              })
          : [],
        needed.has('STREAK_DAYS')
          ? prisma.streak.findUnique({
              where: { client_id: clientId },
              select: { current_days: true, tracking_started_at: true },
            })
          : null,
        needed.has('STREAK_DAYS')
          ? prisma.planAssignment.findMany({
              where: {
                client_id: clientId,
                date: { gte: earliestAssignedAt, lte: normalizeDate(asOf) },
                is_rest_day: false,
                OR: [
                  { trainings: { some: {} } },
                  { training_id: { not: null } },
                  { diet_id: { not: null } },
                ],
              },
              select: { date: true },
              orderBy: { date: 'asc' },
            })
          : [],
      ]);

    await Promise.all(
      assignments.map(async (assignment) => {
        const eligibilityPeriods =
          assignment.assignment_source === ChallengeAssignmentSource.GLOBAL
            ? assignment.eligibility_periods.filter(
                (period) => period.ends_on === null,
              )
            : undefined;
        const baselineValue = eligibilityPeriods?.[0]?.baseline_value ?? 0;
        const assignmentStreak =
          assignment.challenge.rule_key === 'STREAK_DAYS' && eligibilityPeriods
            ? {
                current_days: calculateStreak(
                  streakAssignments,
                  dayProgress,
                  asOf,
                  streak?.tracking_started_at,
                  eligibilityPeriods,
                ).currentDays,
              }
            : streak;
        const contribution = evaluateAutomaticProgress(
          assignment.challenge.rule_key as ChallengeRuleKey | null,
          assignment.assigned_at,
          assignment.challenge.deadline,
          dayProgress,
          bodyMetrics,
          assignmentStreak,
          asOf,
          eligibilityPeriods,
        );
        const currentValue =
          assignment.challenge.rule_key === 'STREAK_DAYS'
            ? Math.max(baselineValue, contribution)
            : baselineValue + contribution;
        const isCompleted = currentValue >= assignment.challenge.target_value;
        if (
          assignment.current_value === currentValue &&
          assignment.is_completed === isCompleted &&
          (isCompleted
            ? assignment.completed_at !== null
            : assignment.completed_at === null)
        )
          return;

        await prisma.challengeClient.update({
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
              ? (assignment.completed_at ?? new Date())
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
    const updatedRecord = await this.prisma.$transaction(async (tx) => {
      await lockClientDayProgress(tx, clientId);
      const record = await tx.challengeClient.findUnique({
        where: {
          challenge_id_client_id: {
            challenge_id: challengeId,
            client_id: clientId,
          },
        },
        include: { challenge: true, eligibility_periods: true },
      });

      if (!record) {
        throw new NotFoundException('Challenge assignment not found');
      }

      if (!record.challenge.is_manual) {
        throw new ForbiddenException(
          'Los retos automáticos se recalculan desde el backend',
        );
      }
      if (
        record.assignment_source === ChallengeAssignmentSource.GLOBAL &&
        (!record.eligibility_periods.some(
          (period) => period.ends_on === null,
        ) ||
          !(await this.eligibleGlobalChallengeIds(clientId, tx, true)).includes(
            challengeId,
          ))
      ) {
        throw new ForbiddenException('El reto no está disponible actualmente');
      }

      const isCompleted = dto.current_value >= record.challenge.target_value;
      return tx.challengeClient.update({
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
            ? (record.completed_at ?? new Date())
            : null,
        },
      });
    });

    await this.evaluateAchievementsForClient(clientId);

    return updatedRecord;
  }

  private async eligibleGlobalChallengeIds(
    clientId: string,
    db: PrismaClientLike,
    lock = false,
  ) {
    if (lock) {
      // Scope triggers lock these rows after their scope write; never invert that order by locking scope here.
      await db.$queryRaw(Prisma.sql`SELECT id FROM challenge_clients
        WHERE client_id = ${clientId} AND assignment_source = 'GLOBAL' ORDER BY id FOR UPDATE`);
    }
    const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT c.id FROM challenges c JOIN challenge_clients cc ON cc.challenge_id = c.id
      JOIN users client ON client.id = cc.client_id LEFT JOIN users creator ON creator.id = c.created_by
      WHERE cc.client_id = ${clientId} AND cc.assignment_source = 'GLOBAL' AND c.is_global = true
        AND client.role = 'CLIENT' AND (c.created_by IS NULL OR creator.role = 'SUPER_ADMIN' OR
          (creator.role = 'ADMIN' AND EXISTS (SELECT 1 FROM admin_client_assignments aca
            WHERE aca.admin_id = c.created_by AND aca.client_id = cc.client_id AND aca.is_active = true)))
    `);
    return rows.map((row) => row.id);
  }
}
