import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { NotificationsService } from './notifications.service';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { Role } from '@prisma/client';
import { NotificationQueryDto } from './dto/notification-query.dto';
import { SendNotificationDto, SendToAllClientsDto } from './dto/send-notification.dto';

@ApiTags('Notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Post('send')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Send a notification to one or more users' })
  @ApiResponse({ status: 201, description: 'Notificacion enviada y persistida correctamente' })
  send(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SendNotificationDto,
  ) {
    if (dto.user_id) {
      return this.notificationsService.sendToUser(
        user.id,
        dto.user_id,
        dto.title,
        dto.body,
        dto.data,
      );
    }

    return this.notificationsService.sendToMultiple(
      user.id,
      dto.user_ids ?? [],
      dto.title,
      dto.body,
      dto.data,
    );
  }

  @Post('send-all')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Send a notification to all accessible clients' })
  @ApiResponse({ status: 201, description: 'Notificaciones enviadas y persistidas correctamente' })
  sendToAll(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SendToAllClientsDto,
  ) {
    return this.notificationsService.sendToAllClients(user.id, dto.title, dto.body, dto.data);
  }

  @Get('history')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Get notification history for the current admin session' })
  @ApiResponse({ status: 200, description: 'Historial de notificaciones obtenido correctamente' })
  getHistory(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: NotificationQueryDto,
  ) {
    return this.notificationsService.getHistory(user.id, query);
  }

  @Get('stats')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Get notification delivery stats for the current admin session' })
  @ApiResponse({ status: 200, description: 'Estadisticas de notificaciones obtenidas correctamente' })
  getStats(@CurrentUser() user: AuthenticatedUser) {
    return this.notificationsService.getStats(user.id);
  }

  @Put(':id/read')
  @HttpCode(200)
  @Roles(Role.CLIENT)
  @ApiOperation({ summary: 'Mark a notification as read for the current client' })
  @ApiResponse({ status: 200, description: 'Notificacion marcada como leida' })
  markAsRead(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.notificationsService.markAsRead(user.id, id);
  }
}
