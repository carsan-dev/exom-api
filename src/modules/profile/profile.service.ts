import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { UploadsService } from '../uploads/uploads.service';
import { UpdateProfileDto } from './dto/update-profile.dto';

@Injectable()
export class ProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly uploadsService: UploadsService,
  ) {}

  private async buildProfileResponse(userId: string) {
    const [profile, totalTrainings] = await Promise.all([
      this.prisma.profile.findUnique({
        where: { user_id: userId },
        include: {
          user: {
            select: {
              email: true,
              role: true,
              streak: {
                select: { current_days: true },
              },
            },
          },
        },
      }),
      this.prisma.dayProgress.count({
        where: { client_id: userId, training_completed: true },
      }),
    ]);

    if (!profile) {
      throw new NotFoundException('Perfil no encontrado');
    }

    return {
      ...profile,
      streakDays: profile.user.streak?.current_days ?? 0,
      totalTrainings,
    };
  }

  async getMyProfile(userId: string) {
    return this.buildProfileResponse(userId);
  }

  async updateMyProfile(userId: string, dto: UpdateProfileDto) {
    const profile = await this.prisma.profile.findUnique({
      where: { user_id: userId },
    });

    if (!profile) {
      throw new NotFoundException('Perfil no encontrado');
    }

    await this.prisma.profile.update({
      where: { user_id: userId },
      data: {
        ...(dto.avatar_url !== undefined && { avatar_url: dto.avatar_url }),
        ...(dto.first_name !== undefined && { first_name: dto.first_name }),
        ...(dto.last_name !== undefined && { last_name: dto.last_name }),
        ...(dto.main_goal !== undefined && { main_goal: dto.main_goal }),
        ...(dto.level !== undefined && { level: dto.level }),
        ...(dto.muscle_mass_goal !== undefined && {
          muscle_mass_goal: dto.muscle_mass_goal,
        }),
        ...(dto.target_calories !== undefined && {
          target_calories: dto.target_calories,
        }),
        ...(dto.current_weight !== undefined && {
          current_weight: dto.current_weight,
        }),
        ...(dto.height !== undefined && { height: dto.height }),
        ...(dto.birth_date !== undefined && { birth_date: dto.birth_date }),
      },
    });

    return this.buildProfileResponse(userId);
  }

  async getAvatarUploadUrl(userId: string) {
    const key = `avatars/${userId}/${Date.now()}.jpg`;
    return this.uploadsService.getPresignedUrl(key, 'image/jpeg');
  }
}
