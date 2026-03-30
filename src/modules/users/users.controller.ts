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
import { UpdateClientAssignmentsDto } from './dto/update-client-assignments.dto';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { Role } from '@prisma/client';

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

  @Post('users')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: 'Dar de alta un cliente' })
  @ApiResponse({ status: 201, description: 'Cliente creado correctamente' })
  @ApiResponse({ status: 409, description: 'El email ya está registrado' })
  createClient(@CurrentUser() admin: AuthenticatedUser, @Body() dto: CreateClientDto) {
    return this.usersService.createClient(admin.id, dto);
  }

  @Put('users/:id/unlock')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: 'Desbloquear cuenta de cliente' })
  @ApiResponse({ status: 200, description: 'Cuenta desbloqueada correctamente' })
  @ApiResponse({ status: 404, description: 'Cliente no encontrado' })
  unlockUser(@Param('id') id: string) {
    return this.usersService.unlockUser(id);
  }

  @Put('users/:id/role')
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Cambiar rol de usuario' })
  @ApiResponse({ status: 200, description: 'Rol actualizado correctamente' })
  @ApiResponse({ status: 404, description: 'Usuario no encontrado' })
  updateRole(@Param('id') id: string, @Body() dto: UpdateRoleDto) {
    return this.usersService.updateRole(id, dto);
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
  @ApiResponse({ status: 400, description: 'El payload es invalido o deja al cliente sin admins' })
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
}
