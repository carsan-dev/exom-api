import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { ApprovalRequestsService } from './approval-requests.service';
import { ApprovalRequestsQueryDto } from './dto/approval-requests-query.dto';
import { MyApprovalRequestsQueryDto } from './dto/my-approval-requests-query.dto';
import { ResolveApprovalRequestDto } from './dto/resolve-approval-request.dto';

@ApiTags('Approval Requests')
@ApiBearerAuth()
@Controller('approval-requests')
export class ApprovalRequestsController {
  constructor(
    private readonly approvalRequestsService: ApprovalRequestsService,
  ) {}

  @Get()
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'List approval requests for super admins' })
  @ApiResponse({ status: 200, description: 'Solicitudes listadas correctamente' })
  @ApiResponse({ status: 400, description: 'Parámetros inválidos' })
  @ApiResponse({ status: 403, description: 'Acceso denegado' })
  findAll(@Query() query: ApprovalRequestsQueryDto) {
    return this.approvalRequestsService.findAll(query);
  }

  @Get('my')
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'List my approval requests' })
  @ApiResponse({ status: 200, description: 'Solicitudes listadas correctamente' })
  @ApiResponse({ status: 400, description: 'Parámetros inválidos' })
  @ApiResponse({ status: 403, description: 'Acceso denegado' })
  findMy(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: MyApprovalRequestsQueryDto,
  ) {
    return this.approvalRequestsService.findByRequester(user.id, query);
  }

  @Get('stats')
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Get approval request stats' })
  @ApiResponse({ status: 200, description: 'Estadísticas obtenidas correctamente' })
  @ApiResponse({ status: 403, description: 'Acceso denegado' })
  getStats() {
    return this.approvalRequestsService.getStats();
  }

  @Get('resource/:resourceType/batch')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Get pending approval indicators for a batch of resources' })
  @ApiResponse({ status: 200, description: 'Indicadores obtenidos correctamente' })
  @ApiResponse({ status: 403, description: 'Acceso denegado' })
  findPendingBatchByResource(
    @Param('resourceType') resourceType: string,
    @Query('ids') ids: string,
  ) {
    const resourceIds = ids
      ?.split(',')
      .map((value) => value.trim())
      .filter(Boolean) ?? [];

    return this.approvalRequestsService.findPendingBatchByResource(
      resourceType,
      resourceIds,
    );
  }

  @Get('resource/:resourceType/:resourceId')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Get pending approval requests for a resource' })
  @ApiResponse({ status: 200, description: 'Solicitudes obtenidas correctamente' })
  @ApiResponse({ status: 403, description: 'Acceso denegado' })
  findPendingByResource(
    @Param('resourceType') resourceType: string,
    @Param('resourceId', ParseUUIDPipe) resourceId: string,
  ) {
    return this.approvalRequestsService.findPendingByResource(
      resourceType,
      resourceId,
    );
  }

  @Get(':id')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Get approval request detail with role-based visibility' })
  @ApiResponse({ status: 200, description: 'Detalle obtenido correctamente segun el rol del usuario' })
  @ApiResponse({ status: 403, description: 'Acceso denegado' })
  @ApiResponse({ status: 404, description: 'Solicitud no encontrada' })
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.approvalRequestsService.findOne(id, user);
  }

  @Put(':id/resolve')
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Approve or reject an approval request' })
  @ApiResponse({ status: 200, description: 'Solicitud resuelta correctamente' })
  @ApiResponse({ status: 400, description: 'Payload inválido' })
  @ApiResponse({ status: 403, description: 'Acceso denegado' })
  @ApiResponse({ status: 404, description: 'Solicitud no encontrada' })
  @ApiResponse({ status: 409, description: 'La solicitud ya fue resuelta' })
  resolve(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ResolveApprovalRequestDto,
  ) {
    return this.approvalRequestsService.resolve(id, user.id, dto);
  }

  @Delete(':id')
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Cancel my pending approval request' })
  @ApiResponse({ status: 200, description: 'Solicitud cancelada correctamente' })
  @ApiResponse({ status: 403, description: 'Acceso denegado' })
  @ApiResponse({ status: 404, description: 'Solicitud no encontrada' })
  @ApiResponse({ status: 409, description: 'La solicitud ya fue resuelta' })
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.approvalRequestsService.cancelRequest(id, user.id);
  }
}
