import { ApiProperty } from '@nestjs/swagger';
import { CatalogValueWithColorDto } from '../../../common/dto/catalog-color.dto';

export class DietNutritionalBadgesResponseDto {
  @ApiProperty({ type: [CatalogValueWithColorDto] })
  nutritional_badges: CatalogValueWithColorDto[];
}
