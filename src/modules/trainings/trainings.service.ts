import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PaginationDto, paginate } from '../../common/dto/pagination.dto';
import { CreateTrainingDto, UpdateTrainingDto } from './dto/create-training.dto';

const trainingExercisesInclude = {
  exercises: {
    orderBy: { order: 'asc' as const },
    include: {
      exercise: true,
    },
  },
};

@Injectable()
export class TrainingsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAllTags() {
    const trainings = await this.prisma.training.findMany({
      where: { is_active: true },
      select: { tags: true },
    });

    const uniqueTags = new Map<string, string>();

    for (const training of trainings) {
      for (const tag of training.tags) {
        const normalizedTag = tag.trim();

        if (!normalizedTag) {
          continue;
        }

        const normalizedKey = normalizedTag.toLocaleLowerCase();

        if (!uniqueTags.has(normalizedKey)) {
          uniqueTags.set(normalizedKey, normalizedTag);
        }
      }
    }

    return {
      tags: Array.from(uniqueTags.values()).sort((left, right) =>
        left.localeCompare(right, 'es', { sensitivity: 'base' }),
      ),
    };
  }

  async findAll(pagination: PaginationDto) {
    const [data, total] = await Promise.all([
      this.prisma.training.findMany({
        where: { is_active: true },
        skip: pagination.skip,
        take: pagination.limit,
        orderBy: { created_at: 'desc' },
        include: trainingExercisesInclude,
      }),
      this.prisma.training.count({ where: { is_active: true } }),
    ]);

    return paginate(data, total, pagination);
  }

  async findToday(clientId: string, date?: Date) {
    const target = date ?? new Date();
    target.setHours(0, 0, 0, 0);

    const assignment = await this.prisma.planAssignment.findUnique({
      where: { client_id_date: { client_id: clientId, date: target } },
      include: {
        training: {
          include: trainingExercisesInclude,
        },
      },
    });

    if (!assignment || !assignment.training) {
      return null;
    }

    return assignment.training;
  }

  async findOne(id: string) {
    const training = await this.prisma.training.findFirst({
      where: { id, is_active: true },
      include: trainingExercisesInclude,
    });

    if (!training) {
      throw new NotFoundException('Entrenamiento no encontrado');
    }

    return training;
  }

  async create(adminId: string, dto: CreateTrainingDto) {
    return this.prisma.$transaction(async (tx) => {
      const training = await tx.training.create({
        data: {
          name: dto.name,
          type: dto.type,
          level: dto.level,
          estimated_duration_min: dto.estimated_duration_min ?? null,
          estimated_calories: dto.estimated_calories ?? null,
          warmup_description: dto.warmup_description ?? null,
          warmup_duration_min: dto.warmup_duration_min ?? null,
          cooldown_description: dto.cooldown_description ?? null,
          tags: dto.tags ?? [],
          created_by: adminId,
        },
      });

      if (dto.exercises && dto.exercises.length > 0) {
        await tx.trainingExercise.createMany({
          data: dto.exercises.map((ex) => ({
            training_id: training.id,
            exercise_id: ex.exercise_id,
            order: ex.order,
            sets: ex.sets,
            reps_or_duration: ex.reps_or_duration,
            rest_seconds: ex.rest_seconds ?? 60,
          })),
        });
      }

      return tx.training.findUnique({
        where: { id: training.id },
        include: trainingExercisesInclude,
      });
    });
  }

  async update(id: string, dto: UpdateTrainingDto) {
    await this.findOne(id);

    return this.prisma.$transaction(async (tx) => {
      await tx.training.update({
        where: { id },
        data: {
          ...(dto.name !== undefined && { name: dto.name }),
          ...(dto.type !== undefined && { type: dto.type }),
          ...(dto.level !== undefined && { level: dto.level }),
          ...(dto.estimated_duration_min !== undefined && {
            estimated_duration_min: dto.estimated_duration_min,
          }),
          ...(dto.estimated_calories !== undefined && {
            estimated_calories: dto.estimated_calories,
          }),
          ...(dto.warmup_description !== undefined && {
            warmup_description: dto.warmup_description,
          }),
          ...(dto.warmup_duration_min !== undefined && {
            warmup_duration_min: dto.warmup_duration_min,
          }),
          ...(dto.cooldown_description !== undefined && {
            cooldown_description: dto.cooldown_description,
          }),
          ...(dto.tags !== undefined && { tags: dto.tags }),
        },
      });

      if (dto.exercises !== undefined) {
        // Re-sync: delete all existing and recreate
        await tx.trainingExercise.deleteMany({ where: { training_id: id } });

        if (dto.exercises.length > 0) {
          await tx.trainingExercise.createMany({
            data: dto.exercises.map((ex) => ({
              training_id: id,
              exercise_id: ex.exercise_id,
              order: ex.order,
              sets: ex.sets,
              reps_or_duration: ex.reps_or_duration,
              rest_seconds: ex.rest_seconds ?? 60,
            })),
          });
        }
      }

      return tx.training.findUnique({
        where: { id },
        include: trainingExercisesInclude,
      });
    });
  }

  async remove(id: string) {
    await this.findOne(id);

    await this.prisma.training.update({
      where: { id },
      data: { is_active: false },
    });
  }
}
