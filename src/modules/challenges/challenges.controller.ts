import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { ChallengesService } from './challenges.service';
import {
  CreateChallengeDto,
  AssignChallengeDto,
  UpdateChallengeDto,
  UpdateProgressDto,
} from './dto/create-challenge.dto';
import {
  ChallengeAssignmentsQueryDto,
  ChallengesQueryDto,
} from './dto/challenges-query.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { Role } from '@prisma/client';

@ApiTags('Challenges')
@ApiBearerAuth()
@Controller('challenges')
export class ChallengesController {
  constructor(private readonly challengesService: ChallengesService) {}

  @Get()
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Get challenges for admin management' })
  @ApiResponse({ status: 200, description: 'Listado admin de retos obtenido correctamente' })
  @ApiResponse({ status: 400, description: 'Parámetros de consulta inválidos' })
  findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ChallengesQueryDto,
  ) {
    return this.challengesService.findAllForAdmin(user.id, user.role, query);
  }

  @Get('my')
  @Roles(Role.CLIENT)
  @ApiOperation({ summary: "Get client's challenges with progress" })
  @ApiResponse({ status: 200, description: 'Listado de retos del cliente obtenido correctamente' })
  findMyChallenges(@CurrentUser() user: AuthenticatedUser) {
    return this.challengesService.findMyChallenges(user.id);
  }

  @Get(':id')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Get challenge detail and assigned client progress' })
  @ApiResponse({ status: 200, description: 'Detalle del reto obtenido correctamente' })
  @ApiResponse({ status: 403, description: 'No tienes permisos sobre este reto' })
  @ApiResponse({ status: 404, description: 'Reto no encontrado' })
  findOne(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ChallengeAssignmentsQueryDto,
  ) {
    return this.challengesService.findOneForAdmin(id, user.id, user.role, query);
  }

  @Post()
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Create a new challenge' })
  @ApiResponse({ status: 201, description: 'Reto creado correctamente' })
  @ApiResponse({ status: 400, description: 'Payload de reto inválido' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateChallengeDto,
  ) {
    return this.challengesService.create(user.id, user.role, dto);
  }

  @Put(':id')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Update challenge metadata and scope' })
  @ApiResponse({ status: 200, description: 'Reto actualizado correctamente' })
  @ApiResponse({ status: 400, description: 'Payload de reto inválido' })
  @ApiResponse({ status: 403, description: 'No tienes permisos sobre este reto' })
  @ApiResponse({ status: 404, description: 'Reto no encontrado' })
  update(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateChallengeDto,
  ) {
    return this.challengesService.update(id, user.id, user.role, dto);
  }

  @Delete(':id')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Delete a challenge and its assignments' })
  @ApiResponse({ status: 200, description: 'Reto eliminado correctamente' })
  @ApiResponse({ status: 403, description: 'No tienes permisos sobre este reto' })
  @ApiResponse({ status: 404, description: 'Reto no encontrado' })
  remove(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.challengesService.remove(id, user.id, user.role);
  }

  @Post(':id/assign')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Assign a challenge to specific or visible clients' })
  @ApiResponse({ status: 200, description: 'Reto asignado correctamente' })
  @ApiResponse({ status: 400, description: 'Payload de asignación inválido' })
  @ApiResponse({ status: 403, description: 'No tienes permisos sobre este reto o cliente' })
  @ApiResponse({ status: 404, description: 'Reto o cliente no encontrado' })
  assignToClient(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: AssignChallengeDto,
  ) {
    return this.challengesService.assignToClients(id, user.id, user.role, dto);
  }

  @Put(':id/progress')
  @Roles(Role.CLIENT)
  @ApiOperation({ summary: 'Update progress on a challenge' })
  @ApiResponse({ status: 200, description: 'Progreso del reto actualizado correctamente' })
  @ApiResponse({ status: 403, description: 'Solo los retos manuales permiten progreso manual' })
  @ApiResponse({ status: 404, description: 'Asignación de reto no encontrada' })
  updateProgress(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateProgressDto,
  ) {
    return this.challengesService.updateProgress(user.id, id, dto);
  }
}
