import { Controller, Get, Post, Body, Param, Query } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { AchievementsService } from './achievements.service';
import { CreateAchievementDto, GrantAchievementDto } from './dto/create-achievement.dto';
import { PaginationDto } from '../../common/dto/pagination.dto';
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
  @ApiOperation({ summary: 'Get all achievements (admin)' })
  findAll(@Query() pagination: PaginationDto) {
    return this.achievementsService.findAll(pagination);
  }

  @Get('my')
  @ApiOperation({ summary: "Get current user's unlocked achievements" })
  findMyAchievements(@CurrentUser() user: AuthenticatedUser) {
    return this.achievementsService.findMyAchievements(user.id);
  }

  @Post()
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Create a new achievement (SUPER_ADMIN only)' })
  create(@Body() dto: CreateAchievementDto) {
    return this.achievementsService.create(dto);
  }

  @Post(':id/grant')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Grant an achievement to a user' })
  grantToUser(
    @Param('id') id: string,
    @Body() dto: GrantAchievementDto,
  ) {
    return this.achievementsService.grantToUser(id, dto);
  }
}
