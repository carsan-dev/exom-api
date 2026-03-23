import { Controller, Post, Body } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional } from 'class-validator';
import { NotificationsService } from './notifications.service';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '@prisma/client';

class SendNotificationDto {
  @ApiProperty()
  @IsString()
  user_id: string;

  @ApiProperty()
  @IsString()
  title: string;

  @ApiProperty()
  @IsString()
  body: string;

  @ApiProperty({ required: false })
  @IsOptional()
  data?: Record<string, string>;
}

@ApiTags('Notifications')
@ApiBearerAuth()
@Controller('notifications')
@Roles(Role.ADMIN, Role.SUPER_ADMIN)
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Post('send')
  @ApiOperation({ summary: 'Send a notification to a user' })
  send(@Body() dto: SendNotificationDto) {
    return this.notificationsService.sendToUser(
      dto.user_id,
      dto.title,
      dto.body,
      dto.data,
    );
  }
}
