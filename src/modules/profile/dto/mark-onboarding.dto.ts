import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import { OnboardingOutcome } from '@prisma/client';

export class MarkOnboardingDto {
  @ApiPropertyOptional({
    enum: OnboardingOutcome,
    nullable: true,
    description:
      'COMPLETED or SKIPPED. Omitted or null stores an unknown outcome (only for marks repaired from a legacy local flag).',
  })
  @IsOptional()
  @IsEnum(OnboardingOutcome)
  outcome?: OnboardingOutcome | null;
}
