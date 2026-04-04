import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Validate,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { PaginationDto } from '../../../common/dto/pagination.dto';
import {
  ACHIEVEMENT_CRITERIA_TYPES,
  type AchievementCriteriaType,
} from '../achievements.constants';

@ValidatorConstraint({ name: 'achievementRecomputeTarget', async: false })
class AchievementRecomputeTargetValidator
  implements ValidatorConstraintInterface
{
  validate(_: boolean | undefined, args: ValidationArguments) {
    const dto = args.object as RecomputeAchievementsDto;
    return Boolean(
      dto.apply_to_all_visible_clients || (dto.user_ids?.length ?? 0) > 0,
    );
  }

  defaultMessage() {
    return 'Debes seleccionar usuarios o aplicar el recálculo a todos los clientes visibles';
  }
}

export class AchievementFiltersDto extends PaginationDto {
  @ApiPropertyOptional({ description: 'Búsqueda en nombre y descripción' })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ description: 'Filtra por tipo de criterio' })
  @IsOptional()
  @IsIn(ACHIEVEMENT_CRITERIA_TYPES)
  criteria_type?: AchievementCriteriaType;
}

export class AchievementUsersQueryDto extends PaginationDto {}

export class RevokeAchievementDto {
  @ApiProperty({ format: 'uuid' })
  @IsNotEmpty()
  @IsUUID('4')
  user_id: string;
}

export class RecomputeAchievementsDto {
  @ApiPropertyOptional({ type: [String], nullable: true })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('4', { each: true })
  achievement_ids?: string[];

  @ApiPropertyOptional({ type: [String], nullable: true })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('4', { each: true })
  user_ids?: string[];

  @ApiPropertyOptional({
    default: false,
    description: 'Aplica el recálculo a todos los clientes visibles para el admin actual',
  })
  @Transform(({ value }) => {
    if (value === undefined) {
      return false;
    }

    if (value === 'true') {
      return true;
    }

    if (value === 'false') {
      return false;
    }

    return value;
  })
  @IsBoolean()
  @Validate(AchievementRecomputeTargetValidator)
  apply_to_all_visible_clients?: boolean = false;
}
