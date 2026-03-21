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
        orderBy: { date: 'desc' },
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
      orderBy: { date: 'desc' },
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

    return records.map((r) => ({
      date: new Date(r.date).toISOString().split('T')[0],
      weight_kg: r.weight_kg,
    }));
  }
}
