import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as admin from 'firebase-admin';
import { PrismaService } from '../../prisma/prisma.service';
import { UploadsService } from '../uploads/uploads.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ManagedUploadPurpose } from '@prisma/client';

@Injectable()
export class ProfileService {
  private readonly logger = new Logger(ProfileService.name);

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
    const avatarChanged = Boolean(dto.avatar_upload_id) || Boolean(
      dto.avatar_url &&
      !this.uploadsService.referencesSame(dto.avatar_url, profile?.avatar_url),
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
        await this.uploadsService.consumePrepared(
          tx,
          userId,
          avatarUpload.id,
          [ManagedUploadPurpose.AVATAR],
        );
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
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        firebase_uid: true,
        profile: { select: { avatar_url: true } },
        feedbackMedia: { select: { media_url: true } },
        managedUploads: { select: { object_key: true } },
      },
    });

    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }

    const mediaUrls = [
      user.profile?.avatar_url ?? null,
      ...user.feedbackMedia.map((m) => m.media_url),
      ...user.managedUploads.map((upload) => `r2://${upload.object_key}`),
    ].filter((url): url is string => !!url);

    await this.prisma.$transaction(async (tx) => {
      await tx.planAssignment.deleteMany({ where: { client_id: userId } });
      await tx.planAssignment.updateMany({
        where: { admin_id: userId },
        data: { admin_id: null },
      });
      await tx.user.delete({ where: { id: userId } });
    });

    await Promise.allSettled(
      mediaUrls.map((url) =>
        this.uploadsService
          .deleteFileByUrl(url)
          .catch((err: unknown) =>
            this.logger.warn(
              `No se pudo eliminar archivo R2 ${url}: ${String(err)}`,
            ),
          ),
      ),
    );

    if (user.firebase_uid && admin.apps.length > 0) {
      try {
        await admin.auth().deleteUser(user.firebase_uid);
      } catch (err: unknown) {
        const code = (err as { code?: string })?.code;
        if (code !== 'auth/user-not-found') {
          this.logger.warn(
            `No se pudo eliminar usuario Firebase ${user.firebase_uid}: ${String(err)}`,
          );
        }
      }
    }

    return { success: true };
  }
}
