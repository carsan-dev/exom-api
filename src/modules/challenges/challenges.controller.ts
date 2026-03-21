import { Controller, Get, Post, Put, Body, Param, Query } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { ChallengesService } from './challenges.service';
import {
  CreateChallengeDto,
  AssignChallengeDto,
  UpdateProgressDto,
} from './dto/create-challenge.dto';
import { PaginationDto } from '../../common/dto/pagination.dto';
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
  @ApiOperation({ summary: 'Get all challenges (admin)' })
  findAll(@Query() pagination: PaginationDto) {
    return this.challengesService.findAll(pagination);
  }

  @Get('my')
  @Roles(Role.CLIENT)
  @ApiOperation({ summary: "Get client's challenges with progress" })
  findMyChallenges(@CurrentUser() user: AuthenticatedUser) {
    return this.challengesService.findMyChallenges(user.id);
  }

  @Post()
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Create a new challenge' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateChallengeDto,
  ) {
    return this.challengesService.create(user.id, dto);
  }

  @Post(':id/assign')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Assign a challenge to a client' })
  assignToClient(
    @Param('id') id: string,
    @Body() dto: AssignChallengeDto,
  ) {
    return this.challengesService.assignToClient(id, dto);
  }

  @Put(':id/progress')
  @Roles(Role.CLIENT)
  @ApiOperation({ summary: 'Update progress on a challenge' })
  updateProgress(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateProgressDto,
  ) {
    return this.challengesService.updateProgress(user.id, id, dto);
  }
}
