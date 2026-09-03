import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { LastSetVideoPolicy } from '@prisma/client';
import { IsBoolean, IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class AssignmentTrainingInputDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  training_id: string;

  @ApiPropertyOptional({ enum: LastSetVideoPolicy, default: LastSetVideoPolicy.AUTO })
  @IsOptional()
  @IsEnum(LastSetVideoPolicy)
  last_set_video_policy?: LastSetVideoPolicy;

  @ApiPropertyOptional({
    deprecated: true,
    description: 'Compatibilidad legacy: true=ALWAYS, false=NEVER',
  })
  @IsOptional()
  @IsBoolean()
  requires_last_set_video?: boolean;
}
