import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PaginationDto, paginate } from '../../common/dto/pagination.dto';
import { CreateExerciseDto, UpdateExerciseDto } from './dto/create-exercise.dto';

@Injectable()
export class ExercisesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(pagination: PaginationDto) {
    const [data, total] = await Promise.all([
      this.prisma.exercise.findMany({
        where: { is_active: true },
        skip: pagination.skip,
        take: pagination.limit,
        orderBy: { created_at: 'desc' },
      }),
      this.prisma.exercise.count({ where: { is_active: true } }),
    ]);

    return paginate(data, total, pagination);
  }

  async findOne(id: string) {
    const exercise = await this.prisma.exercise.findFirst({
      where: { id, is_active: true },
    });

    if (!exercise) {
      throw new NotFoundException('Ejercicio no encontrado');
    }

    return exercise;
  }

  async create(dto: CreateExerciseDto) {
    return this.prisma.exercise.create({
      data: {
        name: dto.name,
        muscle_groups: dto.muscle_groups,
        equipment: dto.equipment,
        level: dto.level,
        video_url: dto.video_url ?? null,
        video_stream_id: dto.video_stream_id ?? null,
        thumbnail_url: dto.thumbnail_url ?? null,
        technique_text: dto.technique_text ?? null,
        common_errors_text: dto.common_errors_text ?? null,
        explanation_text: dto.explanation_text ?? null,
      },
    });
  }

  async update(id: string, dto: UpdateExerciseDto) {
    await this.findOne(id);

    return this.prisma.exercise.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.muscle_groups !== undefined && {
          muscle_groups: dto.muscle_groups,
        }),
        ...(dto.equipment !== undefined && { equipment: dto.equipment }),
        ...(dto.level !== undefined && { level: dto.level }),
        ...(dto.video_url !== undefined && { video_url: dto.video_url }),
        ...(dto.video_stream_id !== undefined && {
          video_stream_id: dto.video_stream_id,
        }),
        ...(dto.thumbnail_url !== undefined && {
          thumbnail_url: dto.thumbnail_url,
        }),
        ...(dto.technique_text !== undefined && {
          technique_text: dto.technique_text,
        }),
        ...(dto.common_errors_text !== undefined && {
          common_errors_text: dto.common_errors_text,
        }),
        ...(dto.explanation_text !== undefined && {
          explanation_text: dto.explanation_text,
        }),
      },
    });
  }

  async remove(id: string) {
    await this.findOne(id);

    await this.prisma.exercise.update({
      where: { id },
      data: { is_active: false },
    });
  }
}
