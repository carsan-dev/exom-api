import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsString, IsUUID, Min } from 'class-validator';

export class CreateAchievementDto {
  @ApiProperty()
  @IsString()
  name: string;

  @ApiProperty()
  @IsString()
  description: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  icon_url?: string;

  @ApiProperty()
  @IsString()
  criteria_type: string;

  @ApiProperty()
  @IsNumber()
  @Min(0)
  criteria_value: number;
}

export class GrantAchievementDto {
  @ApiProperty()
  @IsUUID()
  user_id: string;
}
