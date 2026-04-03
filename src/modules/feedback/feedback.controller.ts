import { Controller, Get, Post, Put, Body, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { FeedbackService } from './feedback.service';
import { CreateFeedbackDto, RespondFeedbackDto } from './dto/create-feedback.dto';
import { AdminFeedbackQueryDto } from './dto/admin-feedback-query.dto';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { Role } from '@prisma/client';

@ApiTags('Feedback')
@ApiBearerAuth()
@Controller('feedback')
export class FeedbackController {
  constructor(private readonly feedbackService: FeedbackService) {}

  @Post()
  @Roles(Role.CLIENT)
  @ApiOperation({ summary: 'Submit feedback media' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateFeedbackDto,
  ) {
    return this.feedbackService.create(user.id, dto);
  }

  @Get('stats')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Obtener resumen de feedback visible para la sesión actual' })
  @ApiResponse({ status: 200, description: 'Estadísticas de feedback obtenidas correctamente' })
  getStats(@CurrentUser() user: AuthenticatedUser) {
    return this.feedbackService.getStats(user.id, user.role);
  }

  @Get()
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Listar feedback multimedia accesible para la sesión actual' })
  @ApiResponse({ status: 200, description: 'Listado de feedback obtenido correctamente' })
  @ApiResponse({ status: 400, description: 'Parámetros de consulta inválidos' })
  findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: AdminFeedbackQueryDto,
  ) {
    return this.feedbackService.findAll(user.id, user.role, query);
  }

  @Get('my')
  @Roles(Role.CLIENT)
  @ApiOperation({ summary: "Get client's own feedback" })
  findMy(
    @CurrentUser() user: AuthenticatedUser,
    @Query() pagination: PaginationDto,
  ) {
    return this.feedbackService.findMy(user.id, pagination);
  }

  @Put(':id/respond')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Responder feedback multimedia accesible para la sesión actual' })
  @ApiResponse({ status: 200, description: 'Feedback respondido correctamente' })
  @ApiResponse({ status: 400, description: 'La respuesta del admin es inválida' })
  @ApiResponse({ status: 403, description: 'No tienes permisos sobre este feedback' })
  @ApiResponse({ status: 404, description: 'Feedback no encontrado' })
  respond(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RespondFeedbackDto,
  ) {
    return this.feedbackService.respond(id, user.id, user.role, dto);
  }
}
