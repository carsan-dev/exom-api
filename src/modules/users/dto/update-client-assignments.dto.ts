import { ApiProperty } from '@nestjs/swagger';
import { ArrayMinSize, ArrayUnique, IsArray, IsUUID } from 'class-validator';

export class UpdateClientAssignmentsDto {
  @ApiProperty({
    type: [String],
    minItems: 1,
    description: 'Listado final de admins activos que quedaran asignados al cliente',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  admin_ids: string[];
}
