import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { IsString } from 'class-validator';
import { UsersService } from './users.service';
import { AdminUsersQueryDto } from './dto/admin-users-query.dto';
import { ClientAssignmentResponseDto } from './dto/client-assignment-response.dto';
import { CreateClientDto, UpdateRoleDto } from './dto/create-client.dto';
import { CreateAdminDto, UpdateUserDto, UpdateUserStatusDto } from './dto/manage-user.dto';
import { UpdateClientAssignmentsDto } from './dto/update-client-assignments.dto';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { Role } from '@prisma/client';
import { AdminClientProgressQueryDto } from './dto/admin-client-progress-query.dto';
import {
  AdminClientCalendarMonthQueryDto,
  AdminClientCalendarWeekQueryDto,
} from './dto/admin-client-calendar-query.dto';
import { AdminClientBodyHistoryQueryDto } from './dto/admin-client-metrics-query.dto';

class UpdateFcmTokenDto {
  @ApiProperty()
  @IsString()
  fcm_token: string;
}

@ApiTags('Admin - Users')
@ApiBearerAuth()
@Controller('admin')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Patch('fcm-token')
  @ApiOperation({ summary: 'Registrar o actualizar FCM token del dispositivo' })
  @ApiResponse({ status: 200, description: 'FCM token actualizado correctamente' })
  updateFcmToken(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateFcmTokenDto,
  ) {
    return this.usersService.updateFcmToken(user.id, dto.fcm_token);
  }

  @Get('users')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: 'Listar usuarios' })
  @ApiQuery({ name: 'role', required: false, enum: Role })
  @ApiResponse({ status: 200, description: 'Listado global de usuarios obtenido correctamente' })
  @ApiResponse({ status: 400, description: 'Parámetros de consulta inválidos' })
  findAll(@Query() query: AdminUsersQueryDto) {
    return this.usersService.findAll(query.role, query);
  }

  @Post('users/admins')
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Dar de alta un admin' })
  @ApiResponse({ status: 201, description: 'Admin creado correctamente' })
  @ApiResponse({ status: 409, description: 'El email ya está registrado' })
  createAdmin(@Body() dto: CreateAdminDto) {
    return this.usersService.createAdmin(dto);
  }

  @Post('users')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: 'Dar de alta un cliente' })
  @ApiResponse({ status: 201, description: 'Cliente creado correctamente' })
  @ApiResponse({ status: 409, description: 'El email ya está registrado' })
  createClient(@CurrentUser() admin: AuthenticatedUser, @Body() dto: CreateClientDto) {
    return this.usersService.createClient(admin.id, admin.role, dto);
  }

  @Put('users/:id')
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Actualizar datos básicos de un usuario' })
  @ApiResponse({ status: 200, description: 'Usuario actualizado correctamente' })
  @ApiResponse({ status: 404, description: 'Usuario no encontrado' })
  @ApiResponse({ status: 409, description: 'El email ya está registrado' })
  updateUser(@Param('id') id: string, @Body() dto: UpdateUserDto) {
    return this.usersService.updateUser(id, dto);
  }

  @Put('users/:id/status')
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Activar o desactivar una cuenta' })
  @ApiResponse({ status: 200, description: 'Estado actualizado correctamente' })
  @ApiResponse({ status: 403, description: 'No puedes desactivar tu propia cuenta' })
  @ApiResponse({ status: 404, description: 'Usuario no encontrado' })
  updateUserStatus(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateUserStatusDto,
  ) {
    return this.usersService.updateUserStatus(admin.id, id, dto);
  }

  @Put('users/:id/unlock')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: 'Desbloquear cuenta de usuario' })
  @ApiResponse({ status: 200, description: 'Cuenta desbloqueada correctamente' })
  @ApiResponse({ status: 404, description: 'Usuario no encontrado' })
  unlockUser(@CurrentUser() admin: AuthenticatedUser, @Param('id') id: string) {
    return this.usersService.unlockUser(admin.id, admin.role, id);
  }

  @Put('users/:id/role')
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Cambiar rol de usuario' })
  @ApiResponse({ status: 200, description: 'Rol actualizado correctamente' })
  @ApiResponse({ status: 403, description: 'No puedes cambiar tu propio rol' })
  @ApiResponse({ status: 404, description: 'Usuario no encontrado' })
  updateRole(@CurrentUser() admin: AuthenticatedUser, @Param('id') id: string, @Body() dto: UpdateRoleDto) {
    return this.usersService.updateRole(admin.id, id, dto);
  }

  @Get('clients')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: 'Listar clientes visibles para la sesión actual' })
  @ApiResponse({ status: 200, description: 'Listado de clientes obtenido correctamente' })
  getMyClients(@CurrentUser() admin: AuthenticatedUser, @Query() pagination?: PaginationDto) {
    return this.usersService.getMyClients(admin.id, admin.role, pagination);
  }

  @Get('clients/:id/assignments')
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Obtener admins activos asignados a un cliente' })
  @ApiResponse({
    status: 200,
    description: 'Asignaciones activas del cliente obtenidas correctamente',
    type: ClientAssignmentResponseDto,
  })
  @ApiResponse({ status: 403, description: 'Solo SUPER_ADMIN puede consultar asignaciones' })
  @ApiResponse({ status: 404, description: 'Cliente no encontrado' })
  getClientAssignments(@CurrentUser() admin: AuthenticatedUser, @Param('id') clientId: string) {
    return this.usersService.getClientAssignments(admin.id, admin.role, clientId);
  }

  @Put('clients/:id/assignments')
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Actualizar de forma atomica los admins activos de un cliente' })
  @ApiResponse({
    status: 200,
    description: 'Asignaciones del cliente actualizadas correctamente',
    type: ClientAssignmentResponseDto,
  })
  @ApiResponse({ status: 400, description: 'El payload es inválido' })
  @ApiResponse({ status: 403, description: 'Solo SUPER_ADMIN puede actualizar asignaciones' })
  @ApiResponse({ status: 404, description: 'Cliente o admin no encontrado' })
  updateClientAssignments(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id') clientId: string,
    @Body() dto: UpdateClientAssignmentsDto,
  ) {
    return this.usersService.updateClientAssignments(admin.id, admin.role, clientId, dto);
  }

  @Get('clients/:id')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: 'Ver perfil completo de un cliente' })
  @ApiResponse({ status: 200, description: 'Perfil de cliente obtenido correctamente' })
  @ApiResponse({ status: 403, description: 'El cliente no está asignado al admin actual' })
  @ApiResponse({ status: 404, description: 'Cliente no encontrado' })
  getClientProfile(@CurrentUser() admin: AuthenticatedUser, @Param('id') clientId: string) {
    return this.usersService.getClientProfile(admin.id, admin.role, clientId);
  }

  @Get('clients/:id/progress')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: 'Progreso diario de un cliente' })
  @ApiResponse({ status: 200, description: 'Progreso del día obtenido correctamente' })
  @ApiResponse({ status: 403, description: 'Sin acceso a este cliente' })
  getClientDayProgress(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id') clientId: string,
    @Query() query: AdminClientProgressQueryDto,
  ) {
    return this.usersService.getClientDayProgress(admin.id, admin.role, clientId, query.date);
  }

  @Get('clients/:id/calendar/month')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: 'Calendario mensual de cumplimiento de un cliente' })
  @ApiResponse({ status: 200, description: 'Calendario mensual obtenido correctamente' })
  getClientCalendarMonth(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id') clientId: string,
    @Query() query: AdminClientCalendarMonthQueryDto,
  ) {
    return this.usersService.getClientCalendarMonth(admin.id, admin.role, clientId, query.year, query.month);
  }

  @Get('clients/:id/calendar/week-summary')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: 'Resumen semanal de un cliente' })
  @ApiResponse({ status: 200, description: 'Resumen semanal obtenido correctamente' })
  getClientWeekSummary(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id') clientId: string,
    @Query() query: AdminClientCalendarWeekQueryDto,
  ) {
    return this.usersService.getClientWeekSummary(admin.id, admin.role, clientId, query.week_start);
  }

  @Get('clients/:id/metrics')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: 'Métricas paginadas de un cliente' })
  @ApiResponse({ status: 200, description: 'Métricas del cliente obtenidas correctamente' })
  getClientMetrics(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id') clientId: string,
    @Query() pagination: PaginationDto,
  ) {
    return this.usersService.getClientMetrics(admin.id, admin.role, clientId, pagination);
  }

  @Get('clients/:id/metrics/weight-history')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: 'Historial de peso de un cliente para gráfica' })
  @ApiResponse({ status: 200, description: 'Historial de peso obtenido correctamente' })
  getClientWeightHistory(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id') clientId: string,
  ) {
    return this.usersService.getClientWeightHistory(admin.id, admin.role, clientId);
  }

  @Get('clients/:id/metrics/body-history')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: 'Historial de una medida corporal de un cliente' })
  @ApiResponse({ status: 200, description: 'Historial de medida obtenido correctamente' })
  getClientBodyHistory(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id') clientId: string,
    @Query() query: AdminClientBodyHistoryQueryDto,
  ) {
    return this.usersService.getClientBodyHistory(admin.id, admin.role, clientId, query.field);
  }
}
