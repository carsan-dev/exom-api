import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsString, ValidateIf } from 'class-validator';

export class ResolveApprovalRequestDto {
  @ApiProperty({ enum: ['approve', 'reject'] })
  @IsString()
  @IsIn(['approve', 'reject'])
  action: 'approve' | 'reject';

  @ApiPropertyOptional()
  @ValidateIf((dto: ResolveApprovalRequestDto) => dto.action === 'reject')
  @IsString()
  @IsNotEmpty()
  rejection_reason?: string;
}
