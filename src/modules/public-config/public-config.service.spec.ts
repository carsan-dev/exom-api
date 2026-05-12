import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { PublicConfigService } from './public-config.service';

const envValues: Record<string, string> = {
  APP_BASE_URL: 'https://exommethod.com',
  ANDROID_STORE_URL: 'https://play.google.com/store/apps/details?id=com.exommethod.exom',
  IOS_STORE_URL: 'https://apps.apple.com/app/id0000000000',
  LATEST_ANDROID_VERSION: '1.0.0',
  LATEST_IOS_VERSION: '1.0.0',
  MIN_ANDROID_BUILD: '6',
  MIN_IOS_BUILD: '1',
  RECOMMENDED_ANDROID_BUILD: '7',
  RECOMMENDED_IOS_BUILD: '1',
  FORCE_ANDROID_UPDATE: 'false',
  FORCE_IOS_UPDATE: 'false',
  UPDATE_TITLE: 'Actualización disponible',
  UPDATE_MESSAGE: 'Hay una nueva versión de EXOM disponible.',
};

describe('PublicConfigService', () => {
  let service: PublicConfigService;
  let prisma: {
    mobileAppConfig: {
      findUnique: jest.Mock;
      upsert: jest.Mock;
    };
  };
  let config: {
    get: jest.Mock;
  };

  beforeEach(() => {
    prisma = {
      mobileAppConfig: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
      },
    };
    config = {
      get: jest.fn((key: string, fallback = '') => envValues[key] ?? fallback),
    };
    service = new PublicConfigService(
      config as unknown as ConfigService,
      prisma as unknown as PrismaService,
    );
  });

  it('falls back to environment config when no database row exists', async () => {
    prisma.mobileAppConfig.findUnique.mockResolvedValue(null);

    await expect(service.getMobileAppConfig()).resolves.toMatchObject({
      latest_android_version: '1.0.0',
      latest_ios_version: '1.0.0',
      min_android_build: 6,
      recommended_android_build: 7,
      force_android_update: false,
    });
  });

  it('uses stored database config when present', async () => {
    prisma.mobileAppConfig.findUnique.mockResolvedValue({
      android_store_url: 'android-url',
      ios_store_url: 'ios-url',
      latest_android_version: '1.0.1',
      latest_ios_version: '1.0.2',
      min_android_build: 60,
      min_ios_build: 59,
      recommended_android_build: 66,
      recommended_ios_build: 59,
      force_android_update: true,
      force_ios_update: false,
      update_title: 'Update',
      update_message: 'Message',
      support_url: 'support',
      privacy_policy_url: 'privacy',
    });

    await expect(service.getMobileAppConfig()).resolves.toMatchObject({
      latest_android_version: '1.0.1',
      min_android_build: 60,
      recommended_android_build: 66,
      force_android_update: true,
    });
  });

  it('marks android release as recommended without changing minimum build', async () => {
    prisma.mobileAppConfig.upsert.mockResolvedValue({
      android_store_url: '',
      ios_store_url: '',
      latest_android_version: '1.0.1',
      latest_ios_version: '1.0.0',
      min_android_build: 6,
      min_ios_build: 1,
      recommended_android_build: 66,
      recommended_ios_build: 1,
      force_android_update: false,
      force_ios_update: false,
      update_title: '',
      update_message: '',
      support_url: '',
      privacy_policy_url: '',
    });

    await service.updateMobileRelease({
      platform: 'android',
      version: '1.0.1',
      build: 66,
      policy: 'recommended',
    });

    expect(prisma.mobileAppConfig.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: {
          latest_android_version: '1.0.1',
          recommended_android_build: 66,
          force_android_update: false,
        },
      }),
    );
  });

  it('marks ios release as blocking by updating minimum build', async () => {
    prisma.mobileAppConfig.upsert.mockResolvedValue({
      android_store_url: '',
      ios_store_url: '',
      latest_android_version: '1.0.0',
      latest_ios_version: '1.0.1',
      min_android_build: 6,
      min_ios_build: 59,
      recommended_android_build: 7,
      recommended_ios_build: 59,
      force_android_update: false,
      force_ios_update: true,
      update_title: '',
      update_message: '',
      support_url: '',
      privacy_policy_url: '',
    });

    await service.updateMobileRelease({
      platform: 'ios',
      version: '1.0.1',
      build: 59,
      policy: 'blocking',
    });

    expect(prisma.mobileAppConfig.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: {
          latest_ios_version: '1.0.1',
          recommended_ios_build: 59,
          force_ios_update: true,
          min_ios_build: 59,
        },
      }),
    );
  });

  it('updates only latest version when policy is none', async () => {
    prisma.mobileAppConfig.upsert.mockResolvedValue({
      android_store_url: '',
      ios_store_url: '',
      latest_android_version: '1.0.2',
      latest_ios_version: '1.0.0',
      min_android_build: 6,
      min_ios_build: 1,
      recommended_android_build: 7,
      recommended_ios_build: 1,
      force_android_update: false,
      force_ios_update: false,
      update_title: '',
      update_message: '',
      support_url: '',
      privacy_policy_url: '',
    });

    await service.updateMobileRelease({
      platform: 'android',
      version: '1.0.2',
      build: 67,
      policy: 'none',
    });

    expect(prisma.mobileAppConfig.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: {
          latest_android_version: '1.0.2',
        },
      }),
    );
  });
});
