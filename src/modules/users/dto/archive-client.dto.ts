import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';
import { Transform } from 'class-transformer';

export class ArchiveClientDto {
  @ApiProperty({ description: 'Visibility in the main client list only' })
  @Transform(({ obj }: { obj: { is_archived: unknown } }) => obj.is_archived)
  @IsBoolean()
  is_archived!: boolean;
}
