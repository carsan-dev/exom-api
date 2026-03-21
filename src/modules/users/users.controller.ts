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
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiQuery, ApiTags } from '@nestjs/swagger';
import { IsString } from 'class-validator';
import { UsersService } from './users.service';
import { CreateClientDto, UpdateRoleDto } from './dto/create-client.dto';
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
  findAll(
    @Query('role') role?: Role,
    @Query() pagination?: PaginationDto,
  ) {
    return this.usersService.findAll(role, pagination);
  }

  @Post('users')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: 'Dar de alta un cliente' })
  createClient(@CurrentUser() admin: AuthenticatedUser, @Body() dto: CreateClientDto) {
    return this.usersService.createClient(admin.id, dto);
  }

  @Put('users/:id/unlock')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: 'Desbloquear cuenta de cliente' })
  unlockUser(@Param('id') id: string) {
    return this.usersService.unlockUser(id);
  }

  @Put('users/:id/role')
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Cambiar rol de usuario' })
  updateRole(@Param('id') id: string, @Body() dto: UpdateRoleDto) {
    return this.usersService.updateRole(id, dto);
  }

  @Get('clients')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: 'Listar mis clientes' })
  getMyClients(@CurrentUser() admin: AuthenticatedUser, @Query() pagination?: PaginationDto) {
    return this.usersService.getMyClients(admin.id, pagination);
  }

  @Get('clients/:id')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: 'Ver perfil completo de un cliente' })
  getClientProfile(@CurrentUser() admin: AuthenticatedUser, @Param('id') clientId: string) {
    return this.usersService.getClientProfile(admin.id, clientId);
  }
}
