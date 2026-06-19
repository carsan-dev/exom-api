import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { normalizeGroupName } from '../../common/catalog-groups/catalog-group.utils';

@Injectable()
export class DietGroupsService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    return this.prisma.dietGroup.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { diets: { where: { is_active: true } } } } },
    }).then((groups) => groups.map(({ _count, normalized_name: _, ...group }) => ({
      ...group, item_count: _count.diets,
    })));
  }

  async create(rawName: string) {
    const { name, normalizedName } = normalizeGroupName(rawName);
    try {
      const { normalized_name: _, ...group } = await this.prisma.dietGroup.create({
        data: { name, normalized_name: normalizedName },
      });
      return { ...group, item_count: 0 };
    } catch (error) { this.handleUnique(error); throw error; }
  }

  async update(id: string, rawName: string) {
    await this.requireGroup(id);
    const { name, normalizedName } = normalizeGroupName(rawName);
    try {
      const result = await this.prisma.dietGroup.update({
        where: { id }, data: { name, normalized_name: normalizedName },
        include: { _count: { select: { diets: { where: { is_active: true } } } } },
      });
      const { _count, normalized_name: _, ...group } = result;
      return { ...group, item_count: _count.diets };
    } catch (error) { this.handleUnique(error); throw error; }
  }

  async remove(id: string) {
    await this.requireGroup(id);
    await this.prisma.dietGroup.delete({ where: { id } });
  }

  async requireGroup(id: string) {
    const group = await this.prisma.dietGroup.findUnique({ where: { id } });
    if (!group) throw new NotFoundException('Grupo de dietas no encontrado');
    return group;
  }

  private handleUnique(error: unknown) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new ConflictException('Ya existe un grupo con ese nombre');
    }
  }
}
