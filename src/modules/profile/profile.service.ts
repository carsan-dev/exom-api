import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientDeletionService } from '../client-deletion/client-deletion.service';
import { PrismaService } from '../../prisma/prisma.service';
import { UploadsService } from '../uploads/uploads.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ManagedUploadPurpose } from '@prisma/client';

@Injectable()
export class ProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly uploadsService: UploadsService,
    private readonly deletion: ClientDeletionService,
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
    const avatarChanged =
      Boolean(dto.avatar_upload_id) ||
      Boolean(
        dto.avatar_url &&
        !this.uploadsService.referencesSame(
          dto.avatar_url,
          profile?.avatar_url,
        ),
      );
    const avatarUpload = avatarChanged
      ? await this.uploadsService.prepareForConsumption({
          ownerId: userId,
          uploadId: dto.avatar_upload_id,
          legacyUrl: dto.avatar_url,
          purposes: [ManagedUploadPurpose.AVATAR],
        })
      : null;

    await this.prisma.$transaction(async (tx) => {
      const profileData = {
        user_id: userId,
        first_name: dto.first_name ?? '',
        last_name: dto.last_name ?? '',
        ...(avatarUpload && { avatar_url: avatarUpload.file_url }),
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
      };
      if (!profile) {
        await tx.profile.create({ data: profileData });
      } else {
        await tx.profile.update({
          where: { user_id: userId },
          data: {
            ...(avatarUpload && { avatar_url: avatarUpload.file_url }),
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
      }
      if (avatarUpload) {
        await this.uploadsService.consumePrepared(tx, userId, avatarUpload.id, [
          ManagedUploadPurpose.AVATAR,
        ]);
      }
    });

    return this.buildProfileResponse(userId);
  }

  async getAvatarUploadUrl(userId: string, role: string) {
    return this.uploadsService.createSession(userId, role, {
      purpose: ManagedUploadPurpose.AVATAR,
      mimeType: 'image/jpeg',
    });
  }

  async deleteMyAccount(userId: string) {
    return this.deletion.deleteSelf(userId);
  }
}
