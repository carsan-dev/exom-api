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
  @Provided()
  @RawInput()
  @IsEnum(ClientFollowUpTaskType)
  type?: ClientFollowUpTaskType;

  @Provided()
  @RawInput()
  @IsString()
  title?: string;

  @ValidateIf(
    (_object: unknown, value: unknown) => value !== undefined && value !== null,
  )
  @RawInput()
  @IsString()
  description?: string | null;

  @Provided()
  @RawInput()
  @IsString()
  @Matches(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/)
  due_date?: string;

  @Provided()
  @RawInput()
  @IsEnum(ClientFollowUpTaskPriority)
  priority?: ClientFollowUpTaskPriority;

  @Provided()
  @RawInput()
  @IsString()
  @IsNotEmpty()
  assigned_to_id?: string;
}

export class CreateClientFollowUpTaskDto extends ClientFollowUpTaskFieldsDto {
  @RawInput()
  @IsString()
  @Matches(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  )
  id!: string;

  // Override optional validation inherited above: these fields are mandatory.
  @ValidateIf(() => true)
  @IsEnum(ClientFollowUpTaskType)
  declare type: ClientFollowUpTaskType;

  @ValidateIf(() => true)
  @IsString()
  declare title: string;

  @ValidateIf(() => true)
  @IsString()
  declare due_date: string;
}

export class UpdateClientFollowUpTaskDto extends ClientFollowUpTaskFieldsDto {
  @RawInput()
  @IsInt()
  @Min(1)
  @Max(2147483647)
  expected_version!: number;

  @Provided()
  @RawInput()
  @IsEnum(ClientFollowUpTaskStatus)
  status?: ClientFollowUpTaskStatus;
}
