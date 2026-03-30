import { ApiProperty } from '@nestjs/swagger';
import { ArrayMinSize, ArrayUnique, IsArray, IsNotEmpty, IsString } from 'class-validator';

export class UpdateClientAssignmentsDto {
  @ApiProperty({
    type: [String],
    minItems: 1,
    description: 'Listado final de admins activos que quedaran asignados al cliente',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  admin_ids: string[];
}
