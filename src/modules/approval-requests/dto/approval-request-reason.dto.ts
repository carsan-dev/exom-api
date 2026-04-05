import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class ApprovalRequestReasonDto {
  @ApiPropertyOptional({
    minLength: 10,
    maxLength: 500,
    description: 'Motivo humano de la solicitud de aprobación',
  })
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  request_reason?: string;
}
