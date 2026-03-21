import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { CalendarService } from './calendar.service';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { Role } from '@prisma/client';

@ApiTags('Calendar')
@ApiBearerAuth()
@Controller('calendar')
@Roles(Role.CLIENT)
export class CalendarController {
  constructor(private readonly calendarService: CalendarService) {}

  @Get('month')
  @ApiOperation({ summary: 'Get monthly calendar with training and diet info' })
  @ApiQuery({ name: 'year', required: true, type: Number })
  @ApiQuery({ name: 'month', required: true, type: Number })
  getMonthCalendar(
    @CurrentUser() user: AuthenticatedUser,
    @Query('year') year: string,
    @Query('month') month: string,
  ) {
    return this.calendarService.getMonthCalendar(
      user.id,
      parseInt(year, 10),
      parseInt(month, 10),
    );
  }

  @Get('week-summary')
  @ApiOperation({ summary: 'Get weekly summary of training and diet completion' })
  @ApiQuery({ name: 'week_start', required: true, type: String, description: 'YYYY-MM-DD' })
  getWeekSummary(
    @CurrentUser() user: AuthenticatedUser,
    @Query('week_start') weekStart: string,
  ) {
    return this.calendarService.getWeekSummary(user.id, weekStart);
  }
}
