import { Injectable, NotFoundException } from '@nestjs/common';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { UpdateProfileDto } from './dto/update-profile.dto';

@Injectable()
export class ProfileService {
  private readonly s3Client: S3Client;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.s3Client = new S3Client({
      region: 'auto',
      endpoint: this.config.get<string>('R2_ENDPOINT'),
      credentials: {
        accessKeyId: this.config.get<string>('R2_ACCESS_KEY_ID', ''),
        secretAccessKey: this.config.get<string>('R2_SECRET_ACCESS_KEY', ''),
      },
    });
  }

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
    const bucket = this.config.get<string>('R2_BUCKET_NAME', '');
    const publicUrl = this.config.get<string>('R2_PUBLIC_URL', '');
    const key = `avatars/${userId}/${Date.now()}.jpg`;

    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: 'image/jpeg',
    });

    const upload_url = await getSignedUrl(this.s3Client, command, {
      expiresIn: 900,
    });

    return {
      upload_url,
      file_url: `${publicUrl}/${key}`,
      key,
    };
  }
}
