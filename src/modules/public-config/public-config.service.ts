import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MobileAppConfigResponseDto } from './dto/mobile-app-config-response.dto';

@Injectable()
export class PublicConfigService {
  constructor(private readonly config: ConfigService) {}

  getMobileAppConfig(): MobileAppConfigResponseDto {
    const appBaseUrl = this.config.get<string>(
      'APP_BASE_URL',
      'https://exommethod.com',
    );

    return {
      android_store_url: this.config.get<string>(
        'ANDROID_STORE_URL',
        `${appBaseUrl}/app`,
      ),
      ios_store_url: this.config.get<string>('IOS_STORE_URL', `${appBaseUrl}/app`),
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

  private getNumber(key: string): number {
    const rawValue = this.config.get<string>(key, '0');
    const parsed = Number.parseInt(rawValue, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  private getBoolean(key: string): boolean {
    return this.config.get<string>(key, 'false').toLowerCase() === 'true';
  }
}
