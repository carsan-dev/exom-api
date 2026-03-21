import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PaginationDto, paginate } from '../../common/dto/pagination.dto';
import {
  CreateChallengeDto,
  AssignChallengeDto,
  UpdateProgressDto,
} from './dto/create-challenge.dto';

@Injectable()
export class ChallengesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(pagination: PaginationDto) {
    const [data, total] = await Promise.all([
      this.prisma.challenge.findMany({
        orderBy: { created_at: 'desc' },
        skip: pagination.skip,
        take: pagination.limit,
        include: { _count: { select: { clients: true } } },
      }),
      this.prisma.challenge.count(),
    ]);

    return paginate(data, total, pagination);
  }

  async findMyChallenges(clientId: string) {
    return this.prisma.challengeClient.findMany({
      where: { client_id: clientId },
      include: { challenge: true },
      orderBy: { assigned_at: 'desc' },
    });
  }

  async create(adminId: string, dto: CreateChallengeDto) {
    return this.prisma.challenge.create({
      data: {
        title: dto.title,
        description: dto.description,
        type: dto.type,
        target_value: dto.target_value,
        unit: dto.unit,
        is_manual: dto.is_manual,
        is_global: dto.is_global,
        deadline: dto.deadline ? new Date(dto.deadline) : undefined,
        created_by: adminId,
      },
    });
  }

  async assignToClient(challengeId: string, dto: AssignChallengeDto) {
    const challenge = await this.prisma.challenge.findUnique({
      where: { id: challengeId },
    });

    if (!challenge) {
      throw new NotFoundException('Challenge not found');
    }

    return this.prisma.challengeClient.upsert({
      where: {
        challenge_id_client_id: {
          challenge_id: challengeId,
          client_id: dto.client_id,
        },
      },
      create: {
        challenge_id: challengeId,
        client_id: dto.client_id,
        current_value: 0,
        is_completed: false,
      },
      update: {},
    });
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

    const isCompleted = dto.current_value >= record.challenge.target_value;

    return this.prisma.challengeClient.update({
      where: {
        challenge_id_client_id: {
          challenge_id: challengeId,
          client_id: clientId,
        },
      },
      data: {
        current_value: dto.current_value,
        is_completed: isCompleted,
        completed_at: isCompleted && !record.is_completed ? new Date() : record.completed_at,
      },
    });
  }
}
