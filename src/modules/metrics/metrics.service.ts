import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PaginationDto, paginate } from '../../common/dto/pagination.dto';
import { AchievementsService } from '../achievements/achievements.service';
import { CreateBodyMetricDto } from './dto/create-metric.dto';
import { ChallengesService } from '../challenges/challenges.service';
import type {
  CreateAdminClientMetricDto,
  UpdateAdminClientMetricDto,
} from '../users/dto/admin-client-metric.dto';

const METRIC_FIELDS = [
  'weight_kg',
  'muscle_mass_kg',
  'height_cm',
  'sleep_hours',
  'neck_cm',
  'shoulders_cm',
  'chest_cm',
  'arm_left_cm',
  'arm_right_cm',
  'forearm_left_cm',
  'forearm_right_cm',
  'waist_cm',
  'hips_cm',
  'thigh_left_cm',
  'thigh_right_cm',
  'calf_left_cm',
  'calf_right_cm',
] as const;

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

  private assertDateIsNotFuture(date: Date) {
    if (date.getTime() > this.normalizeMetricDate().getTime()) {
      throw new BadRequestException('La fecha de la métrica no puede ser futura');
    }
  }

  private hasMetricValue(metric: Record<string, unknown>) {
    return METRIC_FIELDS.some((field) => metric[field] != null);
  }

  private async syncCurrentWeight(clientId: string) {
    const latestWithWeight = await this.prisma.bodyMetric.findFirst({
      where: { client_id: clientId, weight_kg: { not: null } },
      orderBy: [{ date: 'desc' }, { created_at: 'desc' }],
      select: { weight_kg: true },
    });

    await this.prisma.profile.update({
      where: { user_id: clientId },
      data: { current_weight: latestWithWeight?.weight_kg ?? null },
    });
  }

  private async refreshDerivedData(clientId: string) {
    await this.syncCurrentWeight(clientId);
    await this.challengesService.recalculateAutomaticProgress(clientId);
    await this.achievementsService.evaluateAutomaticAchievementsForUser(clientId);
  }

  private throwMetricConflict(error: unknown): never {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      throw new ConflictException('Ya existe una métrica para esa fecha');
    }
    throw error;
  }

  async create(clientId: string, dto: CreateBodyMetricDto) {
    const { date, ...metricData } = dto;
    const targetDate = this.normalizeMetricDate(date);

    const metric = await this.prisma.bodyMetric.upsert({
      where: {
        client_id_date: {
          client_id: clientId,
          date: targetDate,
        },
      },
      create: {
        client_id: clientId,
        date: targetDate,
        ...metricData,
      },
      update: metricData,
    });

    if (metricData.weight_kg != null) {
      await this.syncCurrentWeight(clientId);
    }

    await this.challengesService.recalculateAutomaticProgress(clientId);
    await this.achievementsService.evaluateAutomaticAchievementsForUser(clientId);

    return metric;
  }

  async createForClient(clientId: string, dto: CreateAdminClientMetricDto) {
    const { date, ...metricData } = dto;
    const targetDate = this.normalizeMetricDate(date);
    this.assertDateIsNotFuture(targetDate);

    if (!this.hasMetricValue(metricData)) {
      throw new BadRequestException('Introduce al menos una métrica');
    }

    let metric;
    try {
      metric = await this.prisma.bodyMetric.create({
        data: { client_id: clientId, date: targetDate, ...metricData },
      });
    } catch (error) {
      this.throwMetricConflict(error);
    }

    await this.refreshDerivedData(clientId);
    return metric;
  }

  async updateForClient(
    clientId: string,
    metricId: string,
    dto: UpdateAdminClientMetricDto,
  ) {
    const existing = await this.prisma.bodyMetric.findFirst({
      where: { id: metricId, client_id: clientId },
    });
    if (!existing) {
      throw new NotFoundException('Métrica no encontrada');
    }

    const { date, ...metricData } = dto;
    const nextMetric = { ...existing, ...metricData };
    if (!this.hasMetricValue(nextMetric)) {
      throw new BadRequestException('Introduce al menos una métrica');
    }

    const targetDate = date ? this.normalizeMetricDate(date) : undefined;
    if (targetDate) this.assertDateIsNotFuture(targetDate);

    let metric;
    try {
      metric = await this.prisma.bodyMetric.update({
        where: { id: metricId },
        data: { ...(targetDate ? { date: targetDate } : {}), ...metricData },
      });
    } catch (error) {
      this.throwMetricConflict(error);
    }

    await this.refreshDerivedData(clientId);
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
      orderBy: { date: 'asc' },
      select: { date: true, weight_kg: true },
    });

    return records.map((record) => ({
      date: new Date(record.date).toISOString().split('T')[0],
      weight_kg: record.weight_kg,
    }));
  }
}
