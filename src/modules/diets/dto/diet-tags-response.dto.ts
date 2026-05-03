import { ApiProperty } from '@nestjs/swagger';

export class DietTagsResponseDto {
  @ApiProperty({ type: [String] })
  tags: string[];
}
