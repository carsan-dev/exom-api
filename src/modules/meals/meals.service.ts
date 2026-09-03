import {
  BadRequestException,
  Injectable,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateMealDto } from '../diets/dto/create-diet.dto';
import { CreateMealBodyDto } from './dto/create-meal.dto';
import { UpdateMealDto } from './dto/update-meal.dto';
import { ManagedUploadPurpose, Prisma } from '@prisma/client';
import { UploadsService } from '../uploads/uploads.service';

const mealInclude = {
  ingredients: {
    include: {
      ingredient: true,
    },
  },
  variants: {
    orderBy: { order: 'asc' as const },
    include: {
      ingredients: {
        include: {
          ingredient: true,
        },
      },
    },
  },
};

@Injectable()
export class MealsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly uploadsService: UploadsService,
  ) {}

  async findOne(id: string) {
    const meal = await this.prisma.meal.findUnique({
      where: { id },
      include: mealInclude,
    });

    if (!meal) {
      throw new NotFoundException('Comida no encontrada');
    }

    return meal;
  }

  async createFromBody(dto: CreateMealBodyDto, adminId: string) {
    await this.validateDietOwnership(dto.diet_id, adminId);
    return this.create(dto.diet_id, dto, adminId);
  }

  async createFromApproval(
    dto: CreateMealBodyDto,
    requesterId: string,
    approvalRequestId: string,
  ) {
    return this.create(dto.diet_id, dto, requesterId, approvalRequestId);
  }

  async create(
    dietId: string,
    dto: CreateMealDto,
    ownerId?: string,
    approvalRequestId?: string,
  ) {
    this.validateMealIngredientEquivalents(dto.ingredients);
    const upload = await this.prepareImage(dto, ownerId, approvalRequestId);

    return this.prisma.$transaction(async (tx) => {
      const meal = await tx.meal.create({
        data: {
          diet_id: dietId,
          type: dto.type,
          name: dto.name,
          image_url: upload?.file_url ?? dto.image_url ?? null,
          calories: dto.calories ?? null,
          protein_g: dto.protein_g ?? null,
          carbs_g: dto.carbs_g ?? null,
          fat_g: dto.fat_g ?? null,
          nutritional_badges: dto.nutritional_badges ?? [],
          order: dto.order ?? 0,
          ingredients: {
            create: dto.ingredients.map((ing) => ({
              ingredient_id: ing.ingredient_id,
              quantity: ing.quantity,
              unit: ing.unit,
              grams_equivalent:
                ing.unit === 'g'
                  ? ing.quantity
                  : (ing.grams_equivalent ?? null),
            })),
          },
        },
        include: mealInclude,
      });
      if (upload && ownerId) {
        await this.consumeImage(tx, ownerId, upload.id, approvalRequestId);
      }
      return meal;
    });
  }

  async updateFromDto(id: string, dto: UpdateMealDto, adminId: string) {
    const meal = await this.findOne(id);
    await this.validateDietOwnership(meal.diet_id, adminId);
    return this.update(id, dto, adminId);
  }

  async updateFromApproval(
    id: string,
    dto: UpdateMealDto,
    requesterId: string,
    approvalRequestId: string,
  ) {
    return this.update(id, dto, requesterId, approvalRequestId);
  }

  async update(
    id: string,
    dto: Partial<CreateMealDto>,
    ownerId?: string,
    approvalRequestId?: string,
  ) {
    const existing = await this.findOne(id);
    const hasUnchangedImage =
      !dto.image_upload_id &&
      dto.image_url !== undefined &&
      this.uploadsService.referencesSame(dto.image_url, existing.image_url);
    const upload = hasUnchangedImage
      ? null
      : await this.prepareImage(dto, ownerId, approvalRequestId);

    return this.prisma.$transaction(async (tx) => {
      const meal = await tx.meal.update({
        where: { id },
        data: {
          ...(dto.type !== undefined && { type: dto.type }),
          ...(dto.name !== undefined && { name: dto.name }),
          ...(upload
            ? { image_url: upload.file_url }
            : !hasUnchangedImage &&
              dto.image_url !== undefined && { image_url: dto.image_url }),
          ...(dto.calories !== undefined && { calories: dto.calories }),
          ...(dto.protein_g !== undefined && { protein_g: dto.protein_g }),
          ...(dto.carbs_g !== undefined && { carbs_g: dto.carbs_g }),
          ...(dto.fat_g !== undefined && { fat_g: dto.fat_g }),
          ...(dto.nutritional_badges !== undefined && {
            nutritional_badges: dto.nutritional_badges,
          }),
          ...(dto.order !== undefined && { order: dto.order }),
        },
        include: mealInclude,
      });
      if (upload && ownerId) {
        await this.consumeImage(tx, ownerId, upload.id, approvalRequestId);
      }
      return meal;
    });
  }

  private async prepareImage(
    dto: { image_upload_id?: string; image_url?: string },
    ownerId?: string,
    approvalRequestId?: string,
  ) {
    if (!dto.image_upload_id && !dto.image_url) return null;
    if (!ownerId) {
      throw new BadRequestException({
        code: 'MANAGED_UPLOAD_REQUIRED',
        message: 'La imagen debe pertenecer a una subida gestionada',
      });
    }
    return this.uploadsService.prepareForConsumption({
      ownerId,
      uploadId: dto.image_upload_id,
      legacyUrl: dto.image_url,
      purposes: [ManagedUploadPurpose.MEAL_IMAGE],
      approvalRequestId,
    });
  }

  private consumeImage(
    tx: Prisma.TransactionClient,
    ownerId: string,
    uploadId: string,
    approvalRequestId?: string,
  ) {
    return this.uploadsService.consumePrepared(tx, ownerId, uploadId, [
      ManagedUploadPurpose.MEAL_IMAGE,
    ], approvalRequestId);
  }

  async removeWithAuth(id: string, adminId: string) {
    const meal = await this.findOne(id);
    await this.validateDietOwnership(meal.diet_id, adminId);
    await this.prisma.meal.delete({ where: { id } });
  }

  async removeFromApproval(id: string) {
    await this.remove(id);
  }

  async remove(id: string) {
    await this.findOne(id);
    await this.prisma.meal.delete({ where: { id } });
  }

  private async validateDietOwnership(
    dietId: string,
    adminId: string,
  ): Promise<void> {
    const diet = await this.prisma.diet.findUnique({
      where: { id: dietId },
      select: { created_by: true },
    });

    if (!diet) {
      throw new NotFoundException('Dieta no encontrada');
    }

    if (diet.created_by !== adminId) {
      throw new ForbiddenException(
        'No tienes permiso para modificar esta dieta',
      );
    }
  }

  private validateMealIngredientEquivalents(
    ingredients: CreateMealDto['ingredients'],
  ) {
    const missingEquivalent = ingredients.some(
      (ingredient) =>
        ingredient.unit !== 'g' &&
        (!ingredient.grams_equivalent || ingredient.grams_equivalent <= 0),
    );

    if (missingEquivalent) {
      throw new BadRequestException(
        'Las medidas caseras necesitan equivalente en gramos',
      );
    }
  }
}
