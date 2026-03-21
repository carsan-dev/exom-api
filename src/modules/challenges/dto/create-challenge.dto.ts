import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';
import { ChallengeType } from '@prisma/client';

export class CreateChallengeDto {
  @ApiProperty()
  @IsString()
  title: string;

  @ApiProperty()
  @IsString()
  description: string;

  @ApiProperty({ enum: ChallengeType })
  @IsEnum(ChallengeType)
  type: ChallengeType;

  @ApiProperty()
  @IsNumber()
  @Min(0)
  target_value: number;

  @ApiProperty()
  @IsString()
  unit: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  is_manual?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  is_global?: boolean;

  @ApiPropertyOptional({ description: 'Deadline date YYYY-MM-DD' })
  @IsOptional()
  @IsString()
  deadline?: string;
}

export class AssignChallengeDto {
  @ApiProperty()
  @IsUUID()
  client_id: string;
}

export class UpdateProgressDto {
  @ApiProperty()
  @IsNumber()
  @Min(0)
  current_value: number;
}
