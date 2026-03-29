import { ApiProperty } from '@nestjs/swagger';

export class TrainingTagsResponseDto {
  @ApiProperty({ type: [String] })
  tags: string[];
}
