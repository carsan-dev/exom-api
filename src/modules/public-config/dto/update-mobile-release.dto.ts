import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsInt, IsString, Min } from 'class-validator';

export type MobilePlatform = 'android' | 'ios';
export type MobileUpdatePolicy = 'none' | 'recommended' | 'blocking';

export class UpdateMobileReleaseDto {
  @ApiProperty({ enum: ['android', 'ios'] })
  @IsIn(['android', 'ios'])
  platform: MobilePlatform;

  @ApiProperty()
  @IsString()
  version: string;

  @ApiProperty({ minimum: 1 })
  @IsInt()
  @Min(1)
  build: number;

  @ApiProperty({ enum: ['none', 'recommended', 'blocking'] })
  @IsIn(['none', 'recommended', 'blocking'])
  policy: MobileUpdatePolicy;
}
