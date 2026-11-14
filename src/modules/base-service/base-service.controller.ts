import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { BASE_SERVICE_ROLES } from './base-service.constants';
import {
  BaseDeliveriesService,
  type BaseDeliveryView,
} from './base-deliveries.service';
import {
  BaseSubscribersService,
  type BaseSubscriberPage,
  type BaseSubscriberView,
} from './base-subscribers.service';
import type { BaseRoute } from './base-package-selection';
import {
  ArchiveBaseSubscriberDto,
  CreateBaseDeliveryDto,
  CreateBaseSubscriberDto,
  ListBaseSubscribersDto,
  ResendBaseDeliveryDto,
  UpdateBaseSubscriberDto,
} from './dto/base-service.dto';

const uuid = new ParseUUIDPipe({ version: '4' });

@ApiTags('Admin - Servicio base')
@ApiBearerAuth()
@Controller('admin/base-service')
@Roles(...BASE_SERVICE_ROLES)
export class BaseServiceController {
  constructor(
    private readonly subscribers: BaseSubscribersService,
    private readonly deliveries: BaseDeliveriesService,
  ) {}

  @Get('routes')
  @ApiOperation({ summary: 'Goals, days per week and deliverable months' })
  routes(): Promise<BaseRoute[]> {
    return this.subscribers.routes();
  }

  @Get('subscribers')
  @ApiOperation({ summary: 'List base subscribers (search, archive filter)' })
  listSubscribers(
    @Query() query: ListBaseSubscribersDto,
  ): Promise<BaseSubscriberPage> {
    return this.subscribers.list(query);
  }

  @Post('subscribers')
  @ApiOperation({ summary: 'Create a base subscriber (order code generated)' })
  createSubscriber(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: CreateBaseSubscriberDto,
  ): Promise<BaseSubscriberView> {
    return this.subscribers.create(dto, actor);
  }

  @Get('subscribers/:subscriberId')
  @ApiOperation({ summary: 'Read one base subscriber' })
  getSubscriber(
    @Param('subscriberId', uuid) subscriberId: string,
  ): Promise<BaseSubscriberView> {
    return this.subscribers.get(subscriberId);
  }

  @Patch('subscribers/:subscriberId')
  @ApiOperation({
    summary: 'Edit a base subscriber; applies to future deliveries only',
  })
  updateSubscriber(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('subscriberId', uuid) subscriberId: string,
    @Body() dto: UpdateBaseSubscriberDto,
  ): Promise<BaseSubscriberView> {
    return this.subscribers.update(subscriberId, dto, actor);
  }

  @Put('subscribers/:subscriberId/archive')
  @ApiOperation({ summary: 'Archive or restore a base subscriber (soft)' })
  archiveSubscriber(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('subscriberId', uuid) subscriberId: string,
    @Body() dto: ArchiveBaseSubscriberDto,
  ): Promise<BaseSubscriberView> {
    return this.subscribers.setArchived(subscriberId, dto.is_archived, actor);
  }

  @Get('subscribers/:subscriberId/deliveries')
  @ApiOperation({ summary: 'Deliveries of a subscriber with send history' })
  listDeliveries(
    @Param('subscriberId', uuid) subscriberId: string,
  ): Promise<BaseDeliveryView[]> {
    return this.deliveries.list(subscriberId);
  }

  @Post('subscribers/:subscriberId/deliveries')
  @ApiOperation({
    summary: 'Queue the email with month N (must be the next month)',
  })
  createDelivery(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('subscriberId', uuid) subscriberId: string,
    @Body() dto: CreateBaseDeliveryDto,
  ): Promise<BaseDeliveryView> {
    return this.deliveries.create(subscriberId, dto.month, actor);
  }

  @Post('subscribers/:subscriberId/deliveries/:deliveryId/resend')
  @ApiOperation({ summary: 'Explicitly resend a SENT or FAILED delivery' })
  // Optional body: older admin builds send none (no confirmation).
  @ApiBody({ type: ResendBaseDeliveryDto, required: false })
  resendDelivery(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('subscriberId', uuid) subscriberId: string,
    @Param('deliveryId', uuid) deliveryId: string,
    @Body() dto: ResendBaseDeliveryDto,
  ): Promise<BaseDeliveryView> {
    return this.deliveries.resend(subscriberId, deliveryId, actor, {
      acceptChangedSource: dto.accept_changed_source === true,
    });
  }
}
