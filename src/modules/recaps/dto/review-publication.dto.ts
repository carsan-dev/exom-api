import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  Equals,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

// configureApp enables implicit conversion; commands must preserve raw types.
const RawInput = () =>
  Transform(
    ({ obj, key }: { obj: Record<string, unknown>; key: string }) => obj[key],
  );

export class ReviewDraftDto {
  @ApiProperty({ type: Number, minimum: 0, maximum: 2147483646 })
  @RawInput()
  @IsInt()
  @Min(0)
  @Max(2147483646)
  expected_version!: number;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 3000 })
  @RawInput()
  @IsOptional()
  @IsString()
  @MaxLength(3000)
  coach_summary?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 3000 })
  @RawInput()
  @IsOptional()
  @IsString()
  @MaxLength(3000)
  changes?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 3000 })
  @RawInput()
  @IsOptional()
  @IsString()
  @MaxLength(3000)
  next_week_goals?: string | null;
}

export class ReviewPublishDto {
  @ApiProperty({ type: Number, minimum: 0, maximum: 2147483646 })
  @RawInput()
  @IsInt()
  @Min(0)
  @Max(2147483646)
  expected_version!: number;

  @ApiProperty({ type: Boolean, enum: [true] })
  @RawInput()
  @Equals(true)
  confirm!: boolean;
}
