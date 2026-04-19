import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { NotificationsService } from './notifications.service';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { RequiresApproval } from '../../common/decorators/requires-approval.decorator';
import { Role } from '@prisma/client';
import { NotificationQueryDto } from './dto/notification-query.dto';
import { MyNotificationsQueryDto } from './dto/my-notifications-query.dto';
import { SendNotificationDto, SendToAllClientsDto } from './dto/send-notification.dto';
import {
  CreateNotificationTemplateDto,
  UpdateNotificationTemplateScheduleDto,
  UpdateNotificationTemplateDto,
} from './dto/notification-template.dto';

@ApiTags('Notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Post('send')
  @RequiresApproval('notification.send', 'notification')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Send a notification to one or more users' })
  @ApiResponse({ status: 201, description: 'Notificacion enviada y persistida correctamente' })
  @ApiResponse({ status: 202, description: 'Solicitud de aprobación creada (solo ADMIN)' })
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

  @Get('templates')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'List notification templates' })
  @ApiResponse({ status: 200, description: 'Plantillas obtenidas correctamente' })
  listTemplates() {
    return this.notificationsService.listTemplates();
  }

  @Post('templates')
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Create a manual notification template' })
  @ApiResponse({ status: 201, description: 'Plantilla creada correctamente' })
  createTemplate(@Body() dto: CreateNotificationTemplateDto) {
    return this.notificationsService.createTemplate(dto);
  }

  @Patch('templates/:key')
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Update a notification template' })
  @ApiResponse({ status: 200, description: 'Plantilla actualizada correctamente' })
  updateTemplate(
    @Param('key') key: string,
    @Body() dto: UpdateNotificationTemplateDto,
  ) {
    return this.notificationsService.updateTemplate(key, dto);
  }

  @Patch('templates/:key/schedule')
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Update a scheduled notification template timing' })
  @ApiResponse({ status: 200, description: 'Horario actualizado correctamente' })
  updateTemplateSchedule(
    @Param('key') key: string,
    @Body() dto: UpdateNotificationTemplateScheduleDto,
  ) {
    return this.notificationsService.updateTemplateSchedule(key, dto);
  }

  @Delete('templates/:key')
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Reset or delete a notification template' })
  @ApiResponse({ status: 200, description: 'Plantilla restaurada correctamente' })
  resetTemplate(@Param('key') key: string) {
    return this.notificationsService.resetTemplate(key);
  }

  @Get('me')
  @Roles(Role.CLIENT)
  @ApiOperation({ summary: 'List notifications received by the current client' })
  @ApiResponse({ status: 200, description: 'Notificaciones obtenidas correctamente' })
  getMyNotifications(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: MyNotificationsQueryDto,
  ) {
    return this.notificationsService.getMyNotifications(user.id, query);
  }

  @Get('me/unread-count')
  @Roles(Role.CLIENT)
  @ApiOperation({ summary: 'Count unread notifications for the current client' })
  @ApiResponse({ status: 200, description: 'Contador obtenido correctamente' })
  getMyUnreadCount(@CurrentUser() user: AuthenticatedUser) {
    return this.notificationsService.getMyUnreadCount(user.id);
  }

  @Put('me/read-all')
  @HttpCode(200)
  @Roles(Role.CLIENT)
  @ApiOperation({ summary: 'Mark all notifications as read for the current client' })
  @ApiResponse({ status: 200, description: 'Notificaciones marcadas como leidas' })
  markAllAsRead(@CurrentUser() user: AuthenticatedUser) {
    return this.notificationsService.markAllAsRead(user.id);
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
