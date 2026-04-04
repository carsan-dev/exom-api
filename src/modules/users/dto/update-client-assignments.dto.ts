import { ApiProperty } from '@nestjs/swagger';
import { ArrayUnique, IsArray, IsNotEmpty, IsString } from 'class-validator';

export class UpdateClientAssignmentsDto {
  @ApiProperty({
    type: [String],
    description: 'Listado final de admins activos que quedaran asignados al cliente',
  })
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  admin_ids: string[];
}
