import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PaginationDto, paginate } from '../../common/dto/pagination.dto';
import { CreateBodyMetricDto } from './dto/create-metric.dto';

@Injectable()
export class MetricsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(clientId: string, dto: CreateBodyMetricDto) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    return this.prisma.bodyMetric.create({
      data: {
        client_id: clientId,
        date: today,
        ...dto,
      },
    });
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

  async findLatest(clientId: string) {
    return this.prisma.bodyMetric.findFirst({
      where: { client_id: clientId },
      orderBy: [{ date: 'desc' }, { created_at: 'desc' }],
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
