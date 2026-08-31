import { Transform } from 'class-transformer';
import { IsDateString, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class AdminClientProgressQueryDto {
  @ApiProperty({
    example: '2024-03-15',
    description: 'Fecha en formato YYYY-MM-DD',
  })
  @IsDateString()
  date: string;
}

export class ReplyToTrainingNoteDto extends AdminClientProgressQueryDto {
  @ApiProperty({
    maxLength: 1000,
    description:
      'Respuesta visible para el cliente. Vacía elimina la respuesta.',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(1000)
  reply: string;
}
