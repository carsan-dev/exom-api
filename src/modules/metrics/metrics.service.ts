import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PaginationDto, paginate } from '../../common/dto/pagination.dto';
import { AchievementsService } from '../achievements/achievements.service';
import { CreateBodyMetricDto } from './dto/create-metric.dto';
import { ChallengesService } from '../challenges/challenges.service';

@Injectable()
export class MetricsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly challengesService: ChallengesService,
    private readonly achievementsService: AchievementsService,
  ) {}

  private normalizeMetricDate(date?: string) {
    const now = date != null
      ? (() => {
          const [year, month, day] = date.split('-').map(Number);
          return new Date(Date.UTC(year, month - 1, day));
        })()
      : new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }

  async create(clientId: string, dto: CreateBodyMetricDto) {
    const { date, ...metricData } = dto;
    const targetDate = this.normalizeMetricDate(date);

    const metric = await this.prisma.bodyMetric.create({
      data: {
        client_id: clientId,
        date: targetDate,
        ...metricData,
      },
    });

    await this.challengesService.recalculateAutomaticProgress(clientId);
    await this.achievementsService.evaluateAutomaticAchievementsForUser(clientId);

    return metric;
  }

  async findAll(clientId: string, pagination: PaginationDto) {
    const [data, total] = await Promise.all([
      this.prisma.bodyMetric.findMany({
        where: { client_id: clientId },
        orderBy: [{ date: 'desc' }, { created_at: 'desc' }],
        skip: pagination.skip,
        take: pagination.limit,
      }),
      this.prisma.bodyMetric.count({ where: { client_id: clientId } }),
    ]);

    return paginate(data, total, pagination);
  }

  async findLatest(clientId: string, date?: string) {
    const normalizedDate = date ? this.normalizeMetricDate(date) : undefined;

    return this.prisma.bodyMetric.findFirst({
      where: {
        client_id: clientId,
        ...(normalizedDate != null ? { date: normalizedDate } : {}),
      },
      orderBy:
        normalizedDate == null
          ? [{ date: 'desc' }, { created_at: 'desc' }]
          : [{ created_at: 'desc' }],
    });
  }

  async getWeightHistory(clientId: string) {
    const records = await this.prisma.bodyMetric.findMany({
      where: {
        client_id: clientId,
        weight_kg: { not: null },
      },
      orderBy: [{ date: 'asc' }, { created_at: 'asc' }],
      select: { date: true, weight_kg: true, created_at: true },
    });

    const uniqueByDay = new Map<
      string,
      { date: string; weight_kg: number | null }
    >();

    for (const record of records) {
      const day = new Date(record.date).toISOString().split('T')[0];
      uniqueByDay.set(day, {
        date: day,
        weight_kg: record.weight_kg,
      });
    }

    return [...uniqueByDay.values()];
  }
}
