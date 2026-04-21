import { ApiProperty } from '@nestjs/swagger';

export class ExerciseEquipmentResponseDto {
  @ApiProperty({ type: [String] })
  equipment: string[];
}
