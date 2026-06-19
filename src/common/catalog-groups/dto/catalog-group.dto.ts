import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsDefined, IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';

export class CreateCatalogGroupDto {
  @ApiProperty({ minLength: 1, maxLength: 100 })
  @IsString()
  @MaxLength(100)
  name!: string;
}

export class UpdateCatalogGroupDto extends PartialType(CreateCatalogGroupDto) {}

export class UpdateTrainingGroupMembershipDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  training_ids!: string[];

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsDefined()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  group_id!: string | null;
}

export class UpdateDietGroupMembershipDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  diet_ids!: string[];

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsDefined()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  group_id!: string | null;
}
