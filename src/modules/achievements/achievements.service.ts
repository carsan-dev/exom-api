import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PaginationDto, paginate } from '../../common/dto/pagination.dto';
import { CreateAchievementDto, GrantAchievementDto } from './dto/create-achievement.dto';

@Injectable()
export class AchievementsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(pagination: PaginationDto) {
    const [data, total] = await Promise.all([
      this.prisma.achievement.findMany({
        orderBy: { created_at: 'desc' },
        skip: pagination.skip,
        take: pagination.limit,
        include: { _count: { select: { userAchievements: true } } },
      }),
      this.prisma.achievement.count(),
    ]);

    return paginate(data, total, pagination);
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
}
