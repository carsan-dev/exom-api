import { ApiProperty } from '@nestjs/swagger';

export class TrainingTypesResponseDto {
  @ApiProperty({ type: [String] })
  types: string[];
}
