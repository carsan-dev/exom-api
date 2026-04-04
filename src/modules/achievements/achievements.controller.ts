import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { AchievementsService } from './achievements.service';
import { CreateAchievementDto, GrantAchievementDto } from './dto/create-achievement.dto';
import { UpdateAchievementDto } from './dto/update-achievement.dto';
import {
  AchievementFiltersDto,
  AchievementUsersQueryDto,
  RecomputeAchievementsDto,
  RevokeAchievementDto,
} from './dto/achievement-query.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { Role } from '@prisma/client';

@ApiTags('Achievements')
@ApiBearerAuth()
@Controller('achievements')
export class AchievementsController {
  constructor(private readonly achievementsService: AchievementsService) {}

  @Get()
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Get all achievements with filters (admin)' })
  @ApiResponse({ status: 200, description: 'Listado de logros obtenido correctamente' })
  @ApiResponse({ status: 400, description: 'Parámetros de consulta inválidos' })
  findAll(@Query() filters: AchievementFiltersDto) {
    return this.achievementsService.findAll(filters);
  }

  @Get('my')
  @Roles(Role.CLIENT)
  @ApiOperation({ summary: "Get current user's unlocked achievements" })
  @ApiResponse({ status: 200, description: 'Logros desbloqueados del usuario obtenidos correctamente' })
  @ApiResponse({ status: 403, description: 'Acceso restringido a clientes' })
  findMyAchievements(@CurrentUser() user: AuthenticatedUser) {
    return this.achievementsService.findMyAchievements(user.id);
  }

  @Get(':id')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Get achievement detail with users who unlocked it' })
  @ApiResponse({ status: 200, description: 'Detalle del logro obtenido correctamente' })
  @ApiResponse({ status: 404, description: 'Logro no encontrado' })
  findOne(@Param('id') id: string, @Query() query: AchievementUsersQueryDto) {
    return this.achievementsService.findOne(id, query);
  }

  @Post()
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Create a new achievement' })
  @ApiResponse({ status: 201, description: 'Logro creado correctamente' })
  @ApiResponse({ status: 400, description: 'Payload de logro inválido' })
  create(@Body() dto: CreateAchievementDto, @CurrentUser() admin: AuthenticatedUser) {
    return this.achievementsService.create(dto, admin);
  }

  @Put(':id')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Update an achievement' })
  @ApiResponse({ status: 200, description: 'Logro actualizado correctamente' })
  @ApiResponse({ status: 400, description: 'Payload de logro inválido' })
  @ApiResponse({ status: 404, description: 'Logro no encontrado' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateAchievementDto,
    @CurrentUser() admin: AuthenticatedUser,
  ) {
    return this.achievementsService.update(id, dto, admin);
  }

  @Delete(':id')
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Delete an achievement (SUPER_ADMIN only)' })
  @ApiResponse({ status: 200, description: 'Logro eliminado correctamente' })
  @ApiResponse({ status: 404, description: 'Logro no encontrado' })
  remove(@Param('id') id: string) {
    return this.achievementsService.remove(id);
  }

  @Post(':id/grant')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Grant an achievement to a user' })
  @ApiResponse({ status: 201, description: 'Logro otorgado correctamente' })
  @ApiResponse({ status: 404, description: 'Logro no encontrado' })
  grantToUser(
    @Param('id') id: string,
    @Body() dto: GrantAchievementDto,
    @CurrentUser() admin: AuthenticatedUser,
  ) {
    return this.achievementsService.grantToUser(id, dto, admin);
  }

  @Delete(':id/revoke')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Revoke an achievement from a user' })
  @ApiResponse({ status: 200, description: 'Logro revocado correctamente' })
  @ApiResponse({ status: 404, description: 'Logro o asignación no encontrada' })
  revokeFromUser(
    @Param('id') id: string,
    @Body() dto: RevokeAchievementDto,
    @CurrentUser() admin: AuthenticatedUser,
  ) {
    return this.achievementsService.revokeFromUser(id, dto, admin);
  }

  @Post('recompute')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Recompute automatic achievements for visible clients or a selected batch' })
  @ApiResponse({ status: 200, description: 'Recálculo histórico ejecutado correctamente' })
  @ApiResponse({ status: 400, description: 'Payload de recálculo inválido' })
  recompute(
    @Body() dto: RecomputeAchievementsDto,
    @CurrentUser() admin: AuthenticatedUser,
  ) {
    return this.achievementsService.recomputeAchievements(dto, admin);
  }
}
