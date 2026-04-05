import {
  ParseUUIDPipe,
  Controller,
  Delete,
  Get,
  Post,
  Put,
  Body,
  Param,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiTags,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiOkResponse,
} from '@nestjs/swagger';
import { AssignmentsService } from './assignments.service';
import { BatchAssignDaysDto } from './dto/batch-assign-days.dto';
import { BulkAssignmentDto, CopyWeekDto } from './dto/bulk-assign.dto';
import { GetMonthAssignmentsQueryDto } from './dto/get-month-assignments-query.dto';
import { GetWeekAssignmentsQueryDto } from './dto/get-week-assignments-query.dto';
import { UpdateAssignmentDto } from './dto/update-assignment.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { Role } from '@prisma/client';

@ApiTags('Assignments')
@ApiBearerAuth()
@Controller('assignments')
export class AssignmentsController {
  constructor(private readonly assignmentsService: AssignmentsService) {}

  @Post('batch')
  @ApiOperation({ summary: 'Assign training/diet/rest day combinations per date' })
  @ApiOkResponse({ description: 'Assignments created or updated successfully' })
  @ApiBadRequestResponse({ description: 'Invalid batch assignment payload' })
  @ApiForbiddenResponse({ description: 'Client does not belong to the current admin' })
  @ApiNotFoundResponse({ description: 'Client, training, or diet not found' })
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  batchAssign(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: BatchAssignDaysDto,
  ) {
    return this.assignmentsService.batchAssign(user, dto);
  }

  @Post('bulk')
  @ApiOperation({ summary: 'Bulk-assign training/diet to a client for multiple dates' })
  @ApiOkResponse({ description: 'Assignments created or updated successfully' })
  @ApiBadRequestResponse({ description: 'Invalid assignment payload' })
  @ApiForbiddenResponse({ description: 'Client does not belong to the current admin' })
  @ApiNotFoundResponse({ description: 'Client, training, or diet not found' })
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  bulkAssign(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: BulkAssignmentDto,
  ) {
    return this.assignmentsService.bulkAssign(user, dto);
  }

  @Post('copy-week')
  @ApiOperation({ summary: 'Copy a week of assignments to another week' })
  @ApiOkResponse({ description: 'Week copied successfully' })
  @ApiBadRequestResponse({ description: 'Invalid source or target week' })
  @ApiForbiddenResponse({ description: 'Client does not belong to the current admin' })
  @ApiNotFoundResponse({ description: 'Client not found' })
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  copyWeek(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CopyWeekDto,
  ) {
    return this.assignmentsService.copyWeek(user, dto);
  }

  @Get('week')
  @ApiOperation({ summary: 'Get 7-day assignments for a client' })
  @ApiOkResponse({ description: 'Week assignments fetched successfully' })
  @ApiBadRequestResponse({ description: 'Invalid week query parameters' })
  @ApiForbiddenResponse({ description: 'User cannot access this client week' })
  @ApiNotFoundResponse({ description: 'Client not found' })
  @Roles(Role.ADMIN, Role.SUPER_ADMIN, Role.CLIENT)
  getWeek(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: GetWeekAssignmentsQueryDto,
  ) {
    return this.assignmentsService.getWeek(user, query);
  }

  @Get('month')
  @ApiOperation({ summary: 'Get monthly assignments for a client' })
  @ApiOkResponse({ description: 'Month assignments fetched successfully' })
  @ApiBadRequestResponse({ description: 'Invalid month query parameters' })
  @ApiForbiddenResponse({ description: 'Client does not belong to the current admin' })
  @ApiNotFoundResponse({ description: 'Client not found' })
  @Roles(Role.ADMIN, Role.SUPER_ADMIN, Role.CLIENT)
  getMonth(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: GetMonthAssignmentsQueryDto,
  ) {
    return this.assignmentsService.getMonth(user, query);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update a single assignment day' })
  @ApiOkResponse({ description: 'Assignment updated successfully' })
  @ApiBadRequestResponse({ description: 'Invalid assignment update payload' })
  @ApiForbiddenResponse({ description: 'Client does not belong to the current admin' })
  @ApiNotFoundResponse({ description: 'Assignment, training, or diet not found' })
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAssignmentDto,
  ) {
    return this.assignmentsService.updateAssignment(user, id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a single assignment day' })
  @ApiOkResponse({ description: 'Assignment deleted successfully' })
  @ApiForbiddenResponse({ description: 'Client does not belong to the current admin' })
  @ApiNotFoundResponse({ description: 'Assignment not found' })
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.assignmentsService.deleteAssignment(user, id);
  }
}
