import {
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateNotificationTemplateDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  category?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  title: string;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  body: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  route?: string | null;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class UpdateNotificationTemplateDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  category?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  title?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  body?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  route?: string | null;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class UpdateNotificationTemplateScheduleDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  timezone?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  times?: string[];

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(6)
  weekday?: number | null;
}
