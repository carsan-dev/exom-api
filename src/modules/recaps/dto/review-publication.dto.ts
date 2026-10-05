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
  @RawInput()
  @IsInt()
  @Min(0)
  @Max(2147483646)
  expected_version!: number;

  @RawInput()
  @IsOptional()
  @IsString()
  @MaxLength(3000)
  coach_summary?: string | null;

  @RawInput()
  @IsOptional()
  @IsString()
  @MaxLength(3000)
  changes?: string | null;

  @RawInput()
  @IsOptional()
  @IsString()
  @MaxLength(3000)
  next_week_goals?: string | null;
}

export class ReviewPublishDto {
  @RawInput()
  @IsInt()
  @Min(0)
  @Max(2147483646)
  expected_version!: number;

  @RawInput()
  @Equals(true)
  confirm!: boolean;
}
