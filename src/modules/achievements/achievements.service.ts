import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { paginate } from '../../common/dto/pagination.dto';
import { CreateAchievementDto, GrantAchievementDto } from './dto/create-achievement.dto';
import { UpdateAchievementDto } from './dto/update-achievement.dto';
import {
  AchievementFiltersDto,
  AchievementUsersQueryDto,
  RevokeAchievementDto,
} from './dto/achievement-query.dto';

@Injectable()
export class AchievementsService {
  constructor(private readonly prisma: PrismaService) {}

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
    return this.prisma.userAchievement.findMany({
      where: { user_id: userId },
      include: { achievement: true },
      orderBy: { unlocked_at: 'desc' },
    });
  }

  async create(dto: CreateAchievementDto) {
    return this.prisma.achievement.create({
      data: {
        name: dto.name,
        description: dto.description,
        icon_url: dto.icon_url,
        criteria_type: dto.criteria_type,
        criteria_value: dto.criteria_value,
      },
    });
  }

  async update(id: string, dto: UpdateAchievementDto) {
    const achievement = await this.prisma.achievement.findUnique({ where: { id } });

    if (!achievement) {
      throw new NotFoundException('Achievement not found');
    }

    return this.prisma.achievement.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.icon_url !== undefined && { icon_url: dto.icon_url }),
        ...(dto.criteria_type !== undefined && { criteria_type: dto.criteria_type }),
        ...(dto.criteria_value !== undefined && { criteria_value: dto.criteria_value }),
      },
    });
  }

  async remove(id: string) {
    const achievement = await this.prisma.achievement.findUnique({ where: { id } });

    if (!achievement) {
      throw new NotFoundException('Achievement not found');
    }

    await this.prisma.achievement.delete({ where: { id } });
    return { message: 'Achievement deleted successfully' };
  }

  async grantToUser(achievementId: string, dto: GrantAchievementDto) {
    const achievement = await this.prisma.achievement.findUnique({
      where: { id: achievementId },
    });

    if (!achievement) {
      throw new NotFoundException('Achievement not found');
    }

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

  async revokeFromUser(achievementId: string, dto: RevokeAchievementDto) {
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
}
