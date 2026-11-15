import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { BaseServiceScope } from '@prisma/client';
import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

// Production enables implicit conversion. Keep raw body values so a numeric
// name or a "3" string cannot become valid input by coercion.
const RawInput = () =>
  Transform(
    ({ obj, key }: { obj: Record<string, unknown>; key: string }) => obj[key],
  );
const Provided = () =>
  ValidateIf((_object: unknown, value: unknown) => value !== undefined);

export const GOAL_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const SUBSCRIBER_ARCHIVE_VIEWS = ['visible', 'archived', 'all'] as const;
export type SubscriberArchiveView = (typeof SUBSCRIBER_ARCHIVE_VIEWS)[number];

export class BaseSubscriberFieldsDto {
  @ApiPropertyOptional({
    type: String,
    maxLength: 200,
    description:
      'Printed on every page. Whitespace is collapsed; control characters, more than 80 characters or glyphs the stamp font lacks are rejected (400 INVALID_NAME).',
  })
  @Provided()
  @RawInput()
  @IsString()
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({ type: String, maxLength: 254 })
  @Provided()
  @RawInput()
  @IsString()
  @MaxLength(254)
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({
    type: String,
    pattern: GOAL_PATTERN.source,
    description: 'Objetivo key from GET /admin/base-service/routes',
  })
  @Provided()
  @RawInput()
  @IsString()
  @MaxLength(64)
  @Matches(GOAL_PATTERN)
  goal?: string;

  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: 7 })
  @Provided()
  @RawInput()
  @IsInt()
  @Min(1)
  @Max(7)
  days_per_week?: number;

  @ApiPropertyOptional({
    enum: BaseServiceScope,
    enumName: 'BaseServiceScope',
    description:
      'What the subscriber contracted: TRAINING (training block only), NUTRITION (nutrition guide and, in month 1, the start guide) or BOTH. Applies to deliveries requested afterwards; existing deliveries keep their snapshot_service_scope.',
  })
  @Provided()
  @RawInput()
  @IsEnum(BaseServiceScope)
  service_scope?: BaseServiceScope;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000 })
  @ValidateIf(
    (_object: unknown, value: unknown) => value !== undefined && value !== null,
  )
  @RawInput()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;
}

// Standalone (not extending the optional fields): class-validator skips a
// property when ANY inherited ValidateIf is false, so required fields here
// carry their own decorators.
export class CreateBaseSubscriberDto {
  @ApiProperty({ type: String, maxLength: 200 })
  @RawInput()
  @IsString()
  @MaxLength(200)
  name!: string;

  @ApiProperty({ type: String, maxLength: 254 })
  @RawInput()
  @IsString()
  @MaxLength(254)
  @IsEmail()
  email!: string;

  @ApiProperty({ type: String, pattern: GOAL_PATTERN.source })
  @RawInput()
  @IsString()
  @MaxLength(64)
  @Matches(GOAL_PATTERN)
  goal!: string;

  @ApiProperty({ type: Number, minimum: 1, maximum: 7 })
  @RawInput()
  @IsInt()
  @Min(1)
  @Max(7)
  days_per_week!: number;

  @ApiPropertyOptional({
    enum: BaseServiceScope,
    enumName: 'BaseServiceScope',
    default: BaseServiceScope.BOTH,
    description:
      'What the subscriber contracted: TRAINING (training block only), NUTRITION (nutrition guide and, in month 1, the start guide) or BOTH. Omitted: BOTH.',
  })
  @Provided()
  @RawInput()
  @IsEnum(BaseServiceScope)
  service_scope?: BaseServiceScope;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000 })
  @ValidateIf(
    (_object: unknown, value: unknown) => value !== undefined && value !== null,
  )
  @RawInput()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;
}

export class UpdateBaseSubscriberDto extends BaseSubscriberFieldsDto {}

export class ArchiveBaseSubscriberDto {
  @ApiProperty({ description: 'true archives (no deliveries), false restores' })
  @RawInput()
  @IsBoolean()
  is_archived!: boolean;
}

export class ListBaseSubscribersDto {
  @ApiPropertyOptional({
    description: 'Matches name, email or order code (accent-insensitive)',
    maxLength: 200,
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @ApiPropertyOptional({ enum: SUBSCRIBER_ARCHIVE_VIEWS, default: 'visible' })
  @IsOptional()
  @IsIn(SUBSCRIBER_ARCHIVE_VIEWS)
  archive?: SubscriberArchiveView;

  @ApiPropertyOptional({ default: 1, minimum: 1, maximum: 1000000 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000000)
  page: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}

export class CreateBaseDeliveryDto {
  @ApiProperty({
    type: Number,
    minimum: 1,
    description:
      'Must be the next month: highest existing month + 1, or 1 (409 MONTH_NOT_NEXT otherwise)',
  })
  @RawInput()
  @IsInt()
  @Min(1)
  @Max(1000)
  month!: number;
}

export class ResendBaseDeliveryDto {
  @ApiPropertyOptional({
    type: Boolean,
    default: false,
    description:
      'Confirms resending the CURRENT PDFs of the delivery month and route when they changed (bytes or file set) since the latest send of this delivery. Without it such a resend is refused with 409 SOURCE_CHANGED_SINCE_DELIVERY. Ignored when nothing changed.',
  })
  @Provided()
  @RawInput()
  @IsBoolean()
  accept_changed_source?: boolean;
}
