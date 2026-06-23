import { ApiProperty } from '@nestjs/swagger';
import { CatalogValueWithColorDto } from '../../../common/dto/catalog-color.dto';

export class TrainingTypesResponseDto {
  @ApiProperty({ type: [CatalogValueWithColorDto] })
  types: CatalogValueWithColorDto[];
}
