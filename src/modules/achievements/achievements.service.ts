import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Role, TrainingType } from '@prisma/client';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { paginate } from '../../common/dto/pagination.dto';
import { CreateAchievementDto, GrantAchievementDto } from './dto/create-achievement.dto';
import { UpdateAchievementDto } from './dto/update-achievement.dto';
import {
  AchievementFiltersDto,
  AchievementUsersQueryDto,
  RecomputeAchievementsDto,
  RevokeAchievementDto,
} from './dto/achievement-query.dto';
import {
  ACHIEVEMENT_CRITERIA_TYPES,
  type AchievementCriteriaType,
  type AchievementRuleConfig,
} from './achievements.constants';

type PrismaClientLike = PrismaService | Prisma.TransactionClient;

type AchievementRuleRecord = {
  id: string;
  criteria_type: string;
  criteria_value: number;
  rule_config: Prisma.JsonValue | null;
};

interface AchievementUserMetrics {
  trainingDays: number;
  trainingDaysByType: Partial<Record<TrainingType, number>>;
  streakDays: number;
  completedChallenges: number;
  weightLogs: number;
}

interface AchievementSyncResult {
  granted: number;
  revoked: number;
}

@Injectable()
export class AchievementsService {
  constructor(private readonly prisma: PrismaService) {}

  private isOfficialCriteriaType(
    value: string,
  ): value is AchievementCriteriaType {
    return ACHIEVEMENT_CRITERIA_TYPES.includes(value as AchievementCriteriaType);
  }

  private parseRuleConfig(
    ruleConfig: Prisma.JsonValue | null,
  ): AchievementRuleConfig | null {
    if (
      !ruleConfig ||
      typeof ruleConfig !== 'object' ||
      Array.isArray(ruleConfig)
    ) {
      return null;
    }

    return ruleConfig as AchievementRuleConfig;
  }

  private validateRuleConfig(
    criteriaType: AchievementCriteriaType,
    ruleConfig: AchievementRuleConfig | null | undefined,
  ) {
    const normalizedRuleConfig = ruleConfig
      ? (Object.fromEntries(
          Object.entries(ruleConfig).filter(([, value]) => value !== undefined),
        ) as AchievementRuleConfig)
      : null;

    if (!normalizedRuleConfig || Object.keys(normalizedRuleConfig).length === 0) {
      return null;
    }

    if (criteriaType !== 'TRAINING_DAYS') {
      throw new BadRequestException(
        'Solo TRAINING_DAYS admite configuración adicional en rule_config',
      );
    }

    const invalidKeys = Object.keys(normalizedRuleConfig).filter(
      (key) => key !== 'training_type',
    );

    if (invalidKeys.length > 0) {
      throw new BadRequestException(
        'rule_config solo admite la clave training_type para TRAINING_DAYS',
      );
    }

    if (
      normalizedRuleConfig.training_type !== undefined &&
      !Object.values(TrainingType).includes(normalizedRuleConfig.training_type)
    ) {
      throw new BadRequestException(
        'rule_config.training_type debe ser un tipo de entrenamiento válido',
      );
    }

    return normalizedRuleConfig;
  }

  private buildAchievementCreateData(
    dto: CreateAchievementDto,
  ): Prisma.AchievementCreateInput {
    const normalizedRuleConfig = this.validateRuleConfig(
      dto.criteria_type,
      dto.rule_config,
    );

    return {
      name: dto.name,
      description: dto.description,
      icon_url: dto.icon_url,
      criteria_type: dto.criteria_type,
      criteria_value: dto.criteria_value,
      ...(normalizedRuleConfig
        ? { rule_config: normalizedRuleConfig as Prisma.InputJsonValue }
        : {}),
    };
  }

  private buildAchievementUpdateData(
    achievement: AchievementRuleRecord,
    dto: UpdateAchievementDto,
  ) {
    const currentRuleConfig = this.parseRuleConfig(achievement.rule_config);
    const nextCriteriaType =
      dto.criteria_type ??
      (this.isOfficialCriteriaType(achievement.criteria_type)
        ? achievement.criteria_type
        : null);

    if (!nextCriteriaType) {
      throw new BadRequestException('El logro tiene un criteria_type no soportado');
    }

    const nextRuleConfig =
      dto.rule_config !== undefined
        ? dto.rule_config
        : dto.criteria_type && dto.criteria_type !== achievement.criteria_type
          ? null
          : currentRuleConfig;
    const normalizedRuleConfig = this.validateRuleConfig(
      nextCriteriaType,
      nextRuleConfig,
    );

    const data: Prisma.AchievementUpdateInput = {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.description !== undefined ? { description: dto.description } : {}),
      ...(dto.icon_url !== undefined ? { icon_url: dto.icon_url } : {}),
      ...(dto.criteria_type !== undefined
        ? { criteria_type: dto.criteria_type }
        : {}),
      ...(dto.criteria_value !== undefined
        ? { criteria_value: dto.criteria_value }
        : {}),
      rule_config: normalizedRuleConfig
        ? (normalizedRuleConfig as Prisma.InputJsonValue)
        : Prisma.DbNull,
    };

    return {
      data,
      currentRuleConfig,
      nextCriteriaType,
      normalizedRuleConfig,
    };
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
      where: {
        admin_id: adminId,
        is_active: true,
      },
      select: { client_id: true },
    });

    return [...new Set(assignments.map((assignment) => assignment.client_id))];
  }

  private async resolveAllClientIds(prisma: PrismaClientLike = this.prisma) {
    const clients = await prisma.user.findMany({
      where: { role: Role.CLIENT },
      select: { id: true },
    });

    return clients.map((client) => client.id);
  }

  private async assertClientVisibleToAdmin(
    userId: string,
    admin: Pick<AuthenticatedUser, 'id' | 'role'>,
    prisma: PrismaClientLike = this.prisma,
  ) {
    await this.assertClientIdsExist([userId], prisma);

    if (admin.role === Role.SUPER_ADMIN) {
      return;
    }

    const visibleClientIds = await this.resolveVisibleClientIds(
      admin.id,
      admin.role,
      prisma,
    );

    if (!visibleClientIds.includes(userId)) {
      throw new ForbiddenException('El cliente no está visible para este admin');
    }
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
    dto: RecomputeAchievementsDto,
    admin: Pick<AuthenticatedUser, 'id' | 'role'>,
    prisma: PrismaClientLike = this.prisma,
  ) {
    const visibleClientIds = await this.resolveVisibleClientIds(
      admin.id,
      admin.role,
      prisma,
    );

    if (dto.apply_to_all_visible_clients) {
      return [...new Set(visibleClientIds)];
    }

    const requestedClientIds = [...new Set(dto.user_ids ?? [])];

    if (requestedClientIds.length === 0) {
      return [];
    }

    if (admin.role !== Role.SUPER_ADMIN) {
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

  private async resolveAutomaticAchievements(
    achievementIds: string[] | undefined,
    prisma: PrismaClientLike = this.prisma,
  ) {
    if (!achievementIds?.length) {
      return prisma.achievement.findMany({
        where: {
          criteria_type: {
            in: ACHIEVEMENT_CRITERIA_TYPES.filter((type) => type !== 'CUSTOM'),
          },
        },
        select: {
          id: true,
          criteria_type: true,
          criteria_value: true,
          rule_config: true,
        },
      });
    }

    const uniqueAchievementIds = [...new Set(achievementIds)];

    const achievements = await prisma.achievement.findMany({
      where: { id: { in: uniqueAchievementIds } },
      select: {
        id: true,
        criteria_type: true,
        criteria_value: true,
        rule_config: true,
      },
    });

    if (achievements.length !== uniqueAchievementIds.length) {
      throw new NotFoundException('Uno o más logros no existen');
    }

    const unsupportedAchievement = achievements.find(
      (achievement) => !this.isOfficialCriteriaType(achievement.criteria_type),
    );

    if (unsupportedAchievement) {
      throw new BadRequestException(
        'Uno o más logros tienen un criteria_type no soportado',
      );
    }

    const customAchievement = achievements.find(
      (achievement) => achievement.criteria_type === 'CUSTOM',
    );

    if (customAchievement) {
      throw new BadRequestException(
        'Los logros CUSTOM no se recalculan automáticamente',
      );
    }

    return achievements;
  }

  private async evaluateTrainingDaysByType(
    userId: string,
    completedTrainingDates: Date[],
    prisma: PrismaClientLike = this.prisma,
  ) {
    if (completedTrainingDates.length === 0) {
      return {};
    }

    const assignments = await prisma.planAssignment.findMany({
      where: {
        client_id: userId,
        date: { in: completedTrainingDates },
        training_id: { not: null },
      },
      select: {
        training: {
          select: { type: true },
        },
      },
    });

    return assignments.reduce<Partial<Record<TrainingType, number>>>(
      (accumulator, assignment) => {
        const trainingType = assignment.training?.type;

        if (!trainingType) {
          return accumulator;
        }

        accumulator[trainingType] = (accumulator[trainingType] ?? 0) + 1;
        return accumulator;
      },
      {},
    );
  }

  private resolveAchievementProgress(
    achievement: AchievementRuleRecord,
    metrics: AchievementUserMetrics,
  ) {
    const ruleConfig = this.parseRuleConfig(achievement.rule_config);

    switch (achievement.criteria_type) {
      case 'TRAINING_DAYS':
        return ruleConfig?.training_type
          ? metrics.trainingDaysByType[ruleConfig.training_type] ?? 0
          : metrics.trainingDays;
      case 'STREAK_DAYS':
        return metrics.streakDays;
      case 'CHALLENGES_COMPLETED':
        return metrics.completedChallenges;
      case 'WEIGHT_LOGS':
        return metrics.weightLogs;
      default:
        return 0;
    }
  }

  private buildEligibleAchievementIds(
    metrics: AchievementUserMetrics,
    achievements: AchievementRuleRecord[],
  ) {
    return achievements
      .filter((achievement) =>
        this.resolveAchievementProgress(achievement, metrics) >=
        achievement.criteria_value,
      )
      .map((achievement) => achievement.id);
  }

  private async syncAutomaticAchievementsForUser(
    userId: string,
    achievements: AchievementRuleRecord[],
    metrics: AchievementUserMetrics,
    prisma: PrismaClientLike = this.prisma,
  ): Promise<AchievementSyncResult> {
    if (achievements.length === 0) {
      return { granted: 0, revoked: 0 };
    }

    const scopedAchievementIds = achievements.map((achievement) => achievement.id);
    const eligibleAchievementIds = this.buildEligibleAchievementIds(
      metrics,
      achievements,
    );
    const eligibleAchievementIdSet = new Set(eligibleAchievementIds);

    const existingAchievements = await prisma.userAchievement.findMany({
      where: {
        user_id: userId,
        achievement_id: { in: scopedAchievementIds },
      },
      select: { achievement_id: true },
    });

    const existingAchievementIdSet = new Set(
      existingAchievements.map((achievement) => achievement.achievement_id),
    );
    const achievementIdsToGrant = eligibleAchievementIds.filter(
      (achievementId) => !existingAchievementIdSet.has(achievementId),
    );
    const achievementIdsToRevoke = existingAchievements
      .map((achievement) => achievement.achievement_id)
      .filter((achievementId) => !eligibleAchievementIdSet.has(achievementId));

    const [createdAchievements, deletedAchievements] = await Promise.all([
      achievementIdsToGrant.length > 0
        ? prisma.userAchievement.createMany({
            data: achievementIdsToGrant.map((achievementId) => ({
              user_id: userId,
              achievement_id: achievementId,
            })),
            skipDuplicates: true,
          })
        : Promise.resolve({ count: 0 }),
      achievementIdsToRevoke.length > 0
        ? prisma.userAchievement.deleteMany({
            where: {
              user_id: userId,
              achievement_id: { in: achievementIdsToRevoke },
            },
          })
        : Promise.resolve({ count: 0 }),
    ]);

    return {
      granted: createdAchievements.count,
      revoked: deletedAchievements.count,
    };
  }

  private async recomputeAchievementsForUsers(
    achievements: AchievementRuleRecord[],
    userIds: string[],
    prisma: PrismaClientLike = this.prisma,
  ) {
    if (achievements.length === 0 || userIds.length === 0) {
      return {
        achievements_evaluated: achievements.length,
        users_evaluated: userIds.length,
        granted: 0,
        revoked: 0,
      };
    }

    const scopedAchievementIds = achievements.map((achievement) => achievement.id);
    const results = await Promise.all(
      userIds.map((userId) =>
        this.evaluateAutomaticAchievementsForUser(
          userId,
          prisma,
          scopedAchievementIds,
        ),
      ),
    );

    return {
      achievements_evaluated: achievements.length,
      users_evaluated: userIds.length,
      granted: results.reduce(
        (accumulator, result) => accumulator + result.granted,
        0,
      ),
      revoked: results.reduce(
        (accumulator, result) => accumulator + result.revoked,
        0,
      ),
    };
  }

  private async recomputeAutomaticAchievementsGlobally(
    achievementIds: string[],
    prisma: PrismaClientLike = this.prisma,
  ) {
    const [achievements, userIds] = await Promise.all([
      this.resolveAutomaticAchievements(achievementIds, prisma),
      this.resolveAllClientIds(prisma),
    ]);

    return this.recomputeAchievementsForUsers(achievements, userIds, prisma);
  }

  private async clearAchievementUnlocksGlobally(
    achievementId: string,
    prisma: PrismaClientLike = this.prisma,
  ) {
    return prisma.userAchievement.deleteMany({
      where: { achievement_id: achievementId },
    });
  }

  async findAll(filters: AchievementFiltersDto) {
    const where: {
      OR?: { name?: { contains: string; mode: 'insensitive' }; description?: { contains: string; mode: 'insensitive' } }[];
      criteria_type?: string;
    } = {};

    if (filters.search?.trim()) {
      where.OR = [
        { name: { contains: filters.search.trim(), mode: 'insensitive' } },
        { description: { contains: filters.search.trim(), mode: 'insensitive' } },
      ];
    }

    if (filters.criteria_type) {
      where.criteria_type = filters.criteria_type;
    }

    const [data, total, criteriaGroups, grandTotal] = await Promise.all([
      this.prisma.achievement.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip: filters.skip,
        take: filters.limit ?? 10,
        include: { _count: { select: { userAchievements: true } } },
      }),
      this.prisma.achievement.count({ where }),
      this.prisma.achievement.groupBy({
        by: ['criteria_type'],
        _count: { id: true },
      }),
      this.prisma.achievement.count(),
    ]);

    const criteria_types: Record<string, number> = {};
    for (const group of criteriaGroups) {
      criteria_types[group.criteria_type] = group._count.id;
    }

    const mappedData = data.map((a) => ({
      ...a,
      unlocked_count: a._count.userAchievements,
    }));

    const result = paginate(mappedData, total, filters);
    return {
      ...result,
      summary: {
        total: grandTotal,
        criteria_types,
      },
    };
  }

  async findOne(id: string, query: AchievementUsersQueryDto) {
    const achievement = await this.prisma.achievement.findUnique({
      where: { id },
      include: { _count: { select: { userAchievements: true } } },
    });

    if (!achievement) {
      throw new NotFoundException('Achievement not found');
    }

    const [users, usersTotal] = await Promise.all([
      this.prisma.userAchievement.findMany({
        where: { achievement_id: id },
        orderBy: { unlocked_at: 'desc' },
        skip: query.skip,
        take: query.limit ?? 10,
        include: {
          user: {
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
      }),
      this.prisma.userAchievement.count({ where: { achievement_id: id } }),
    ]);

    const paginatedUsers = paginate(users, usersTotal, query);

    return {
      ...achievement,
      unlocked_count: achievement._count.userAchievements,
      users: paginatedUsers,
    };
  }

  async findMyAchievements(userId: string) {
    await this.evaluateAutomaticAchievementsForUser(userId);

    return this.prisma.userAchievement.findMany({
      where: { user_id: userId },
      include: { achievement: true },
      orderBy: { unlocked_at: 'desc' },
    });
  }

  async create(
    dto: CreateAchievementDto,
    _admin: Pick<AuthenticatedUser, 'id' | 'role'>,
  ) {
    const achievement = await this.prisma.achievement.create({
      data: this.buildAchievementCreateData(dto),
    });

    if (achievement.criteria_type !== 'CUSTOM') {
      await this.recomputeAutomaticAchievementsGlobally([achievement.id]);
    }

    return achievement;
  }

  async update(
    id: string,
    dto: UpdateAchievementDto,
    _admin: Pick<AuthenticatedUser, 'id' | 'role'>,
  ) {
    const achievement = await this.prisma.achievement.findUnique({ where: { id } });

    if (!achievement) {
      throw new NotFoundException('Achievement not found');
    }

    const {
      data,
      currentRuleConfig,
      nextCriteriaType,
      normalizedRuleConfig,
    } = this.buildAchievementUpdateData(achievement, dto);
    const wasAutomatic = achievement.criteria_type !== 'CUSTOM';

    const shouldRecompute =
      nextCriteriaType !== 'CUSTOM' &&
      (
        achievement.criteria_type !== nextCriteriaType ||
        dto.criteria_value !== undefined ||
        JSON.stringify(currentRuleConfig ?? null) !==
          JSON.stringify(normalizedRuleConfig ?? null)
      );
    const shouldClearGlobalUnlocks = nextCriteriaType === 'CUSTOM' && wasAutomatic;

    const updatedAchievement = await this.prisma.achievement.update({
      where: { id },
      data,
    });

    if (shouldRecompute) {
      await this.recomputeAutomaticAchievementsGlobally([updatedAchievement.id]);
    }

    if (shouldClearGlobalUnlocks) {
      await this.clearAchievementUnlocksGlobally(updatedAchievement.id);
    }

    return updatedAchievement;
  }

  async remove(id: string) {
    const achievement = await this.prisma.achievement.findUnique({ where: { id } });

    if (!achievement) {
      throw new NotFoundException('Achievement not found');
    }

    await this.prisma.achievement.delete({ where: { id } });
    return { message: 'Achievement deleted successfully' };
  }

  async grantToUser(
    achievementId: string,
    dto: GrantAchievementDto,
    admin: Pick<AuthenticatedUser, 'id' | 'role'>,
  ) {
    const achievement = await this.prisma.achievement.findUnique({
      where: { id: achievementId },
    });

    if (!achievement) {
      throw new NotFoundException('Achievement not found');
    }

    await this.assertClientVisibleToAdmin(dto.user_id, admin);

    return this.prisma.userAchievement.upsert({
      where: {
        user_id_achievement_id: {
          user_id: dto.user_id,
          achievement_id: achievementId,
        },
      },
      create: {
        user_id: dto.user_id,
        achievement_id: achievementId,
      },
      update: {},
    });
  }

  async revokeFromUser(
    achievementId: string,
    dto: RevokeAchievementDto,
    admin: Pick<AuthenticatedUser, 'id' | 'role'>,
  ) {
    const achievement = await this.prisma.achievement.findUnique({
      where: { id: achievementId },
      select: { id: true },
    });

    if (!achievement) {
      throw new NotFoundException('Achievement not found');
    }

    await this.assertClientVisibleToAdmin(dto.user_id, admin);

    const userAchievement = await this.prisma.userAchievement.findUnique({
      where: {
        user_id_achievement_id: {
          user_id: dto.user_id,
          achievement_id: achievementId,
        },
      },
    });

    if (!userAchievement) {
      throw new NotFoundException('User achievement not found');
    }

    await this.prisma.userAchievement.delete({
      where: {
        user_id_achievement_id: {
          user_id: dto.user_id,
          achievement_id: achievementId,
        },
      },
    });

    return { message: 'Achievement revoked successfully' };
  }

  async evaluateUserAchievementMetrics(
    userId: string,
    prisma: PrismaClientLike = this.prisma,
  ) {
    const [completedTrainingEntries, completedChallenges, weightLogs, streak] =
      await Promise.all([
        prisma.dayProgress.findMany({
          where: {
            client_id: userId,
            training_completed: true,
          },
          select: { date: true },
        }),
        prisma.challengeClient.count({
          where: {
            client_id: userId,
            is_completed: true,
          },
        }),
        prisma.bodyMetric.count({
          where: {
            client_id: userId,
            weight_kg: { not: null },
          },
        }),
        prisma.streak.findUnique({
          where: { client_id: userId },
          select: { current_days: true },
        }),
      ]);

    const completedTrainingDates = completedTrainingEntries.map(
      (entry) => entry.date,
    );
    const trainingDaysByType = await this.evaluateTrainingDaysByType(
      userId,
      completedTrainingDates,
      prisma,
    );

    return {
      trainingDays: completedTrainingEntries.length,
      trainingDaysByType,
      streakDays: streak?.current_days ?? 0,
      completedChallenges,
      weightLogs,
    } satisfies AchievementUserMetrics;
  }

  async evaluateAutomaticAchievementsForUser(
    userId: string,
    prisma: PrismaClientLike = this.prisma,
    achievementIds?: string[],
  ) {
    const achievements = await this.resolveAutomaticAchievements(
      achievementIds,
      prisma,
    );

    if (achievements.length === 0) {
      return {
        user_id: userId,
        evaluated: 0,
        granted: 0,
        revoked: 0,
      };
    }

    const metrics = await this.evaluateUserAchievementMetrics(userId, prisma);
    const syncResult = await this.syncAutomaticAchievementsForUser(
      userId,
      achievements,
      metrics,
      prisma,
    );

    return {
      user_id: userId,
      evaluated: achievements.length,
      granted: syncResult.granted,
      revoked: syncResult.revoked,
    };
  }

  async recomputeAchievements(
    dto: RecomputeAchievementsDto,
    admin: Pick<AuthenticatedUser, 'id' | 'role'>,
    prisma: PrismaClientLike = this.prisma,
  ) {
    const [achievements, userIds] = await Promise.all([
      this.resolveAutomaticAchievements(dto.achievement_ids, prisma),
      this.resolveTargetClientIds(dto, admin, prisma),
    ]);

    return this.recomputeAchievementsForUsers(achievements, userIds, prisma);
  }
}
