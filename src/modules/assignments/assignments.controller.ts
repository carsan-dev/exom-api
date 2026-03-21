import {
  Controller,
  Get,
  Post,
  Body,
  Query,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
} from '@nestjs/swagger';
import { AssignmentsService } from './assignments.service';
import { BulkAssignmentDto, CopyWeekDto } from './dto/bulk-assign.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { Role } from '@prisma/client';

@ApiTags('Assignments')
@ApiBearerAuth()
@Controller('assignments')
export class AssignmentsController {
  constructor(private readonly assignmentsService: AssignmentsService) {}

  @Post('bulk')
  @ApiOperation({ summary: 'Bulk-assign training/diet to a client for multiple dates' })
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  bulkAssign(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: BulkAssignmentDto,
  ) {
    return this.assignmentsService.bulkAssign(user.id, dto);
  }

  @Post('copy-week')
  @ApiOperation({ summary: 'Copy a week of assignments to another week' })
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  copyWeek(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CopyWeekDto,
  ) {
    return this.assignmentsService.copyWeek(user.id, dto);
  }

  @Get('week')
  @ApiOperation({ summary: 'Get 7-day assignments for a client' })
  @ApiQuery({ name: 'client_id', required: true, type: String })
  @ApiQuery({ name: 'week_start', required: true, type: String })
  @Roles(Role.ADMIN, Role.SUPER_ADMIN, Role.CLIENT)
  getWeek(
    @Query('client_id') clientId: string,
    @Query('week_start') weekStart: string,
  ) {
    return this.assignmentsService.getWeek(clientId, weekStart);
  }
}
