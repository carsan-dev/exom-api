import { ApiProperty } from '@nestjs/swagger';

export class DietNutritionalBadgesResponseDto {
  @ApiProperty({ type: [String] })
  nutritional_badges: string[];
}
