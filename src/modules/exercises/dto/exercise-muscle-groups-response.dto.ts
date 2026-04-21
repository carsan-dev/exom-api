import { ApiProperty } from '@nestjs/swagger';

export class ExerciseMuscleGroupsResponseDto {
  @ApiProperty({ type: [String] })
  muscle_groups: string[];
}
