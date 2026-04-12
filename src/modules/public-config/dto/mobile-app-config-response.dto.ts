import { ApiProperty } from '@nestjs/swagger';

export class MobileAppConfigResponseDto {
  @ApiProperty()
  android_store_url: string;

  @ApiProperty()
  ios_store_url: string;

  @ApiProperty()
  latest_android_version: string;

  @ApiProperty()
  latest_ios_version: string;

  @ApiProperty()
  min_android_build: number;

  @ApiProperty()
  min_ios_build: number;

  @ApiProperty()
  recommended_android_build: number;

  @ApiProperty()
  recommended_ios_build: number;

  @ApiProperty()
  force_android_update: boolean;

  @ApiProperty()
  force_ios_update: boolean;

  @ApiProperty()
  update_title: string;

  @ApiProperty()
  update_message: string;

  @ApiProperty()
  support_url: string;

  @ApiProperty()
  privacy_policy_url: string;
}
