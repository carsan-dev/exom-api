import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { normalizeGroupName } from '../../common/catalog-groups/catalog-group.utils';

@Injectable()
export class TrainingGroupsService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    return this.prisma.trainingGroup
      .findMany({
        orderBy: { name: 'asc' },
        include: { _count: { select: { trainings: { where: { is_active: true } } } } },
      })
      .then((groups) =>
        groups.map(({ _count, normalized_name: _, ...group }) => ({
          ...group,
          item_count: _count.trainings,
        })),
      );
  }

  async create(rawName: string) {
    const { name, normalizedName } = normalizeGroupName(rawName);
    try {
      const { normalized_name: _, ...group } = await this.prisma.trainingGroup.create({
        data: { name, normalized_name: normalizedName },
      });
      return { ...group, item_count: 0 };
    } catch (error) {
      this.handleUnique(error);
      throw error;
    }
  }

  async update(id: string, rawName: string) {
    await this.requireGroup(id);
    const { name, normalizedName } = normalizeGroupName(rawName);
    try {
      const { normalized_name: _, ...group } = await this.prisma.trainingGroup.update({
        where: { id },
        data: { name, normalized_name: normalizedName },
        include: { _count: { select: { trainings: { where: { is_active: true } } } } },
      });
      const count = (group as typeof group & { _count?: { trainings: number } })._count;
      const { _count: __, ...result } = group as typeof group & { _count?: { trainings: number } };
      return { ...result, item_count: count?.trainings ?? 0 };
    } catch (error) {
      this.handleUnique(error);
      throw error;
    }
  }

  async remove(id: string) {
    await this.requireGroup(id);
    await this.prisma.trainingGroup.delete({ where: { id } });
  }

  async requireGroup(id: string) {
    const group = await this.prisma.trainingGroup.findUnique({ where: { id } });
    if (!group) throw new NotFoundException('Grupo de entrenamientos no encontrado');
    return group;
  }

  private handleUnique(error: unknown) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new ConflictException('Ya existe un grupo con ese nombre');
    }
  }
}
