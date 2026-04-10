import { Controller, Get, Post, Put, Body, Param, Query, HttpCode } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { RecapsService } from './recaps.service';
import { CreateRecapDto, UpdateRecapDto, ReviewRecapDto } from './dto/create-recap.dto';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { AdminRecapQueryDto } from './dto/admin-recap-query.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { Role } from '@prisma/client';

@ApiTags('Recaps')
@ApiBearerAuth()
@Controller('recaps')
export class RecapsController {
  constructor(private readonly recapsService: RecapsService) {}

  // ── Client routes (declared before :id to avoid NestJS resolving 'my' as an id) ──

  @Get('my')
  @Roles(Role.CLIENT)
  @ApiOperation({ summary: "Get client's own recap history" })
  @ApiResponse({ status: 200, description: 'Historial de recaps obtenido correctamente' })
  findMyRecaps(
    @CurrentUser() user: AuthenticatedUser,
    @Query() pagination: PaginationDto,
  ) {
    return this.recapsService.findMyRecaps(user.id, pagination);
  }

  @Get('my/:id')
  @Roles(Role.CLIENT)
  @ApiOperation({ summary: 'Get a single recap detail for the client, including trainer feedback' })
  @ApiResponse({ status: 200, description: 'Detalle de recap obtenido correctamente' })
  @ApiResponse({ status: 403, description: 'Acceso denegado' })
  @ApiResponse({ status: 404, description: 'Recap no encontrado' })
  getMyRecapById(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.recapsService.getMyRecapById(user.id, id);
  }

  @Post('my/:id/read-feedback')
  @HttpCode(200)
  @Roles(Role.CLIENT)
  @ApiOperation({ summary: 'Mark trainer feedback on a recap as read' })
  @ApiResponse({ status: 200, description: 'Feedback marcado como leído' })
  @ApiResponse({ status: 403, description: 'Acceso denegado' })
  @ApiResponse({ status: 404, description: 'Recap no encontrado' })
  markFeedbackAsRead(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.recapsService.markClientFeedbackAsRead(user.id, id);
  }

  // ── Admin routes ──

  @Get('stats')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Get recap stats for admin review' })
  @ApiResponse({ status: 200, description: 'Estadísticas de recaps obtenidas correctamente' })
  getStats(@CurrentUser() user: AuthenticatedUser) {
    return this.recapsService.getStats(user.id, user.role);
  }

  @Get()
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({ summary: "Get submitted/reviewed recaps for admin's clients" })
  @ApiResponse({ status: 200, description: 'Listado admin de recaps obtenido correctamente' })
  @ApiResponse({ status: 400, description: 'Parámetros de consulta inválidos' })
  findForAdmin(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: AdminRecapQueryDto,
  ) {
    return this.recapsService.findForAdmin(user.id, user.role, query);
  }

  @Get(':id')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Get recap detail for admin review' })
  @ApiResponse({ status: 200, description: 'Detalle de recap obtenido correctamente' })
  @ApiResponse({ status: 403, description: 'No tienes permisos sobre este recap' })
  @ApiResponse({ status: 404, description: 'Recap no encontrado' })
  findOne(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.recapsService.getAdminRecapById(user.id, user.role, id);
  }

  @Post()
  @Roles(Role.CLIENT)
  @ApiOperation({ summary: 'Create a new weekly recap (DRAFT)' })
  @ApiResponse({ status: 201, description: 'Recap guardado correctamente como borrador' })
  @ApiResponse({ status: 400, description: 'Payload de recap inválido' })
  @ApiResponse({ status: 403, description: 'Solo se pueden sobrescribir recaps en borrador' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateRecapDto,
  ) {
    return this.recapsService.create(user.id, dto);
  }

  @Put(':id')
  @Roles(Role.CLIENT)
  @ApiOperation({ summary: 'Update a recap (only if owner and not REVIEWED)' })
  @ApiResponse({ status: 200, description: 'Recap actualizado correctamente' })
  @ApiResponse({ status: 400, description: 'Payload de recap inválido' })
  @ApiResponse({ status: 403, description: 'No puedes editar este recap' })
  @ApiResponse({ status: 404, description: 'Recap no encontrado' })
  update(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateRecapDto,
  ) {
    return this.recapsService.update(user.id, id, dto);
  }

  @Post(':id/submit')
  @HttpCode(200)
  @Roles(Role.CLIENT)
  @ApiOperation({ summary: 'Submit a recap' })
  @ApiResponse({ status: 200, description: 'Recap enviado correctamente' })
  @ApiResponse({ status: 403, description: 'No puedes enviar este recap' })
  @ApiResponse({ status: 404, description: 'Recap no encontrado' })
  submit(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.recapsService.submit(user.id, id);
  }

  @Put(':id/review')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Mark a recap as reviewed and optionally add internal note and/or client feedback' })
  @ApiResponse({ status: 200, description: 'Recap revisado correctamente' })
  @ApiResponse({ status: 400, description: 'El comentario es inválido' })
  @ApiResponse({ status: 403, description: 'No puedes revisar este recap en su estado actual' })
  @ApiResponse({ status: 404, description: 'Recap no encontrado' })
  review(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ReviewRecapDto,
  ) {
    return this.recapsService.review(user.id, user.role, id, dto);
  }

  @Put(':id/archive')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Archive a reviewed recap' })
  @ApiResponse({ status: 200, description: 'Recap archivado correctamente' })
  @ApiResponse({ status: 403, description: 'Solo se pueden archivar recaps revisados y accesibles' })
  @ApiResponse({ status: 404, description: 'Recap no encontrado' })
  archive(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.recapsService.archive(user.id, user.role, id);
  }
}
