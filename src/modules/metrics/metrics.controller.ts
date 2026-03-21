import { Controller, Get, Post, Body, Query } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { MetricsService } from './metrics.service';
import { CreateBodyMetricDto } from './dto/create-metric.dto';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { Role } from '@prisma/client';

@ApiTags('Metrics')
@ApiBearerAuth()
@Controller('metrics')
@Roles(Role.CLIENT)
export class MetricsController {
  constructor(private readonly metricsService: MetricsService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new body metric record' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateBodyMetricDto,
  ) {
    return this.metricsService.create(user.id, dto);
  }

  @Get('latest')
  @ApiOperation({ summary: 'Get most recent body metric record' })
  findLatest(@CurrentUser() user: AuthenticatedUser) {
    return this.metricsService.findLatest(user.id);
  }

  @Get('weight-history')
  @ApiOperation({ summary: 'Get weight history for charting' })
  getWeightHistory(@CurrentUser() user: AuthenticatedUser) {
    return this.metricsService.getWeightHistory(user.id);
  }

  @Get()
  @ApiOperation({ summary: 'Get paginated body metric history' })
  findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Query() pagination: PaginationDto,
  ) {
    return this.metricsService.findAll(user.id, pagination);
  }
}
