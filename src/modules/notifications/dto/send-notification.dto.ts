import {
  ApiHideProperty,
  ApiProperty,
  ApiPropertyOptional,
  PickType,
} from '@nestjs/swagger';
import {
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Validate,
  ValidateIf,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

@ValidatorConstraint({ name: 'notificationData', async: false })
class NotificationDataValidator implements ValidatorConstraintInterface {
  validate(value: unknown) {
    if (value === undefined) {
      return true;
    }

    if (
      value === null ||
      Array.isArray(value) ||
      Object.prototype.toString.call(value) !== '[object Object]'
    ) {
      return false;
    }

    return Object.values(value as Record<string, unknown>).every(
      (entry) => typeof entry === 'string',
    );
  }

  defaultMessage() {
    return 'data debe ser un objeto plano con valores string';
  }
}

@ValidatorConstraint({ name: 'notificationRecipientTarget', async: false })
class NotificationRecipientTargetValidator
  implements ValidatorConstraintInterface
{
  validate(_: unknown, args: ValidationArguments) {
    const dto = args.object as SendNotificationDto;
    const hasUserId = typeof dto.user_id === 'string' && dto.user_id.trim().length > 0;
    const hasUserIds = Array.isArray(dto.user_ids) && dto.user_ids.length > 0;

    return hasUserId !== hasUserIds;
  }

  defaultMessage() {
    return 'Debes enviar exactamente uno de user_id o user_ids';
  }
}

export class NotificationContentDto {
  @ApiProperty({ maxLength: 100 })
  @IsString()
  @MaxLength(100)
  title: string;

  @ApiProperty({ maxLength: 500 })
  @IsString()
  @MaxLength(500)
  body: string;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'string' },
  })
  @ValidateIf((_, value: unknown) => value !== undefined)
  @Validate(NotificationDataValidator)
  data?: Record<string, string>;
}

export class SendNotificationDto extends NotificationContentDto {
  @ApiPropertyOptional({ description: 'UUID del destinatario para envio individual' })
  @IsOptional()
  @IsUUID()
  user_id?: string;

  @ApiPropertyOptional({
    description: 'UUIDs de destinatarios para envio multiple',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  user_ids?: string[];

  @ApiHideProperty()
  @Validate(NotificationRecipientTargetValidator)
  recipient_target?: boolean;
}

export class SendToAllClientsDto extends PickType(NotificationContentDto, [
  'title',
  'body',
  'data',
] as const) {}
