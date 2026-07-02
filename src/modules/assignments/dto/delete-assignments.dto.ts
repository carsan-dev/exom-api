import { ApiProperty } from '@nestjs/swagger';
import { ArrayMinSize, ArrayUnique, IsArray, IsUUID } from 'class-validator';

export class DeleteAssignmentsDto {
  @ApiProperty({
    type: [String],
    description: 'Assignment identifiers to delete',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsUUID('4', { each: true })
  assignment_ids: string[];
}
