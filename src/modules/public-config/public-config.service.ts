import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MobileAppConfigResponseDto } from './dto/mobile-app-config-response.dto';
import { UpdateMobileReleaseDto } from './dto/update-mobile-release.dto';

const DEFAULT_ANDROID_STORE_URL =
  'https://play.google.com/store/apps/details?id=com.exommethod.exom';
const DEFAULT_IOS_STORE_URL = 'https://apps.apple.com/es/app/exom/id6763056692';

@Injectable()
export class PublicConfigService {
  private readonly configId = 'default';

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async getMobileAppConfig(): Promise<MobileAppConfigResponseDto> {
    const stored = await this.prisma.mobileAppConfig.findUnique({
      where: { id: this.configId },
    });

    if (stored) {
      return {
        android_store_url: stored.android_store_url,
        ios_store_url: stored.ios_store_url,
        latest_android_version: stored.latest_android_version,
        latest_ios_version: stored.latest_ios_version,
        min_android_build: stored.min_android_build,
        min_ios_build: stored.min_ios_build,
        recommended_android_build: stored.recommended_android_build,
        recommended_ios_build: stored.recommended_ios_build,
        force_android_update: stored.force_android_update,
        force_ios_update: stored.force_ios_update,
        update_title: stored.update_title,
        update_message: stored.update_message,
        support_url: stored.support_url,
        privacy_policy_url: stored.privacy_policy_url,
      };
    }

    return this.getEnvMobileAppConfig();
  }

  async updateMobileRelease(
    dto: UpdateMobileReleaseDto,
  ): Promise<MobileAppConfigResponseDto> {
    const base = this.getEnvMobileAppConfig();
    const createData: Prisma.MobileAppConfigCreateInput = {
      id: this.configId,
      ...base,
    };

    const stored = await this.prisma.mobileAppConfig.upsert({
      where: { id: this.configId },
      create: this.buildReleaseCreate(createData, dto),
      update: this.buildReleaseUpdate(dto),
    });

    return {
      android_store_url: stored.android_store_url,
      ios_store_url: stored.ios_store_url,
      latest_android_version: stored.latest_android_version,
      latest_ios_version: stored.latest_ios_version,
      min_android_build: stored.min_android_build,
      min_ios_build: stored.min_ios_build,
      recommended_android_build: stored.recommended_android_build,
      recommended_ios_build: stored.recommended_ios_build,
      force_android_update: stored.force_android_update,
      force_ios_update: stored.force_ios_update,
      update_title: stored.update_title,
      update_message: stored.update_message,
      support_url: stored.support_url,
      privacy_policy_url: stored.privacy_policy_url,
    };
  }

  private getEnvMobileAppConfig(): MobileAppConfigResponseDto {
    const appBaseUrl = this.config.get<string>(
      'APP_BASE_URL',
      'https://exommethod.com',
    );

    return {
      android_store_url: this.config.get<string>(
        'ANDROID_STORE_URL',
        DEFAULT_ANDROID_STORE_URL,
      ),
      ios_store_url: this.config.get<string>(
        'IOS_STORE_URL',
        DEFAULT_IOS_STORE_URL,
      ),
      latest_android_version: this.config.get<string>('LATEST_ANDROID_VERSION', ''),
      latest_ios_version: this.config.get<string>('LATEST_IOS_VERSION', ''),
      min_android_build: this.getNumber('MIN_ANDROID_BUILD'),
      min_ios_build: this.getNumber('MIN_IOS_BUILD'),
      recommended_android_build: this.getNumber('RECOMMENDED_ANDROID_BUILD'),
      recommended_ios_build: this.getNumber('RECOMMENDED_IOS_BUILD'),
      force_android_update: this.getBoolean('FORCE_ANDROID_UPDATE'),
      force_ios_update: this.getBoolean('FORCE_IOS_UPDATE'),
      update_title: this.config.get<string>(
        'UPDATE_TITLE',
        'Actualizacion disponible',
      ),
      update_message: this.config.get<string>(
        'UPDATE_MESSAGE',
        'Hay una nueva version de EXOM disponible.',
      ),
      support_url: this.config.get<string>('SUPPORT_URL', `${appBaseUrl}/support`),
      privacy_policy_url: this.config.get<string>(
        'PRIVACY_POLICY_URL',
        `${appBaseUrl}/privacy`,
      ),
    };
  }

  private buildReleaseUpdate(
    dto: UpdateMobileReleaseDto,
  ): Prisma.MobileAppConfigUpdateInput {
    const isAndroid = dto.platform === 'android';
    const update: Prisma.MobileAppConfigUpdateInput = isAndroid
      ? { latest_android_version: dto.version }
      : { latest_ios_version: dto.version };

    if (dto.policy === 'none') {
      return update;
    }

    if (isAndroid) {
      update.recommended_android_build = dto.build;
      update.force_android_update = dto.policy === 'blocking';
      if (dto.policy === 'blocking') {
        update.min_android_build = dto.build;
      }
      return update;
    }

    update.recommended_ios_build = dto.build;
    update.force_ios_update = dto.policy === 'blocking';
    if (dto.policy === 'blocking') {
      update.min_ios_build = dto.build;
    }
    return update;
  }

  private buildReleaseCreate(
    base: Prisma.MobileAppConfigCreateInput,
    dto: UpdateMobileReleaseDto,
  ): Prisma.MobileAppConfigCreateInput {
    const create = { ...base };
    const isAndroid = dto.platform === 'android';

    if (isAndroid) {
      create.latest_android_version = dto.version;
    } else {
      create.latest_ios_version = dto.version;
    }

    if (dto.policy === 'none') {
      return create;
    }

    if (isAndroid) {
      create.recommended_android_build = dto.build;
      create.force_android_update = dto.policy === 'blocking';
      if (dto.policy === 'blocking') {
        create.min_android_build = dto.build;
      }
      return create;
    }

    create.recommended_ios_build = dto.build;
    create.force_ios_update = dto.policy === 'blocking';
    if (dto.policy === 'blocking') {
      create.min_ios_build = dto.build;
    }
    return create;
  }

  private getNumber(key: string): number {
    const rawValue = this.config.get<string>(key, '0');
    const parsed = Number.parseInt(rawValue, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  private getBoolean(key: string): boolean {
    return this.config.get<string>(key, 'false').toLowerCase() === 'true';
  }
}
