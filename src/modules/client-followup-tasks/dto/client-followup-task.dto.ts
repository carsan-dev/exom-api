import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsString,
  Matches,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import {
  ClientFollowUpTaskPriority,
  ClientFollowUpTaskStatus,
  ClientFollowUpTaskType,
} from '@prisma/client';

// Production enables implicit conversion. Preserve raw values so numeric titles,
// null enums and string versions cannot become valid command inputs by coercion.
const RawInput = () =>
  Transform(
    ({ obj, key }: { obj: Record<string, unknown>; key: string }) => obj[key],
  );
const Provided = () =>
  ValidateIf((_object: unknown, value: unknown) => value !== undefined);

export class ClientFollowUpTaskFieldsDto {
  @ApiPropertyOptional({ enum: ClientFollowUpTaskType })
  @Provided()
  @RawInput()
  @IsEnum(ClientFollowUpTaskType)
  type?: ClientFollowUpTaskType;

  @ApiPropertyOptional({ type: String })
  @Provided()
  @RawInput()
  @IsString()
  title?: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  @ValidateIf(
    (_object: unknown, value: unknown) => value !== undefined && value !== null,
  )
  @RawInput()
  @IsString()
  description?: string | null;

  @ApiPropertyOptional({
    type: String,
    pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$',
  })
  @Provided()
  @RawInput()
  @IsString()
  @Matches(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/)
  due_date?: string;

  @ApiPropertyOptional({ enum: ClientFollowUpTaskPriority })
  @Provided()
  @RawInput()
  @IsEnum(ClientFollowUpTaskPriority)
  priority?: ClientFollowUpTaskPriority;

  @ApiPropertyOptional({ type: String, minLength: 1 })
  @Provided()
  @RawInput()
  @IsString()
  @IsNotEmpty()
  assigned_to_id?: string;
}

export class CreateClientFollowUpTaskDto extends ClientFollowUpTaskFieldsDto {
  @ApiProperty({
    type: String,
    pattern:
      '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$',
  })
  @RawInput()
  @IsString()
  @Matches(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  )
  id!: string;

  // Override optional validation inherited above: these fields are mandatory.
  @ApiProperty({ enum: ClientFollowUpTaskType, required: true })
  @ValidateIf(() => true)
  @IsEnum(ClientFollowUpTaskType)
  declare type: ClientFollowUpTaskType;

  @ApiProperty({ type: String, required: true })
  @ValidateIf(() => true)
  @IsString()
  declare title: string;

  @ApiProperty({
    type: String,
    required: true,
    pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$',
  })
  @ValidateIf(() => true)
  @IsString()
  declare due_date: string;
}

export class UpdateClientFollowUpTaskDto extends ClientFollowUpTaskFieldsDto {
  @ApiProperty({ type: Number, minimum: 1, maximum: 2147483647 })
  @RawInput()
  @IsInt()
  @Min(1)
  @Max(2147483647)
  expected_version!: number;

  @ApiPropertyOptional({ enum: ClientFollowUpTaskStatus })
  @Provided()
  @RawInput()
  @IsEnum(ClientFollowUpTaskStatus)
  status?: ClientFollowUpTaskStatus;
}
