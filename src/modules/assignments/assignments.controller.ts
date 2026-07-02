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
import {
  CreateAutoAssignmentRuleDto,
  GetActiveAutoAssignmentRuleQueryDto,
} from './dto/auto-assignment-rule.dto';
import { BulkAssignmentDto, CopySelectionDto, CopyWeekDto } from './dto/bulk-assign.dto';
import { GetMonthAssignmentsQueryDto } from './dto/get-month-assignments-query.dto';
import { GetWeekAssignmentsQueryDto } from './dto/get-week-assignments-query.dto';
import { UpdateAssignmentDto } from './dto/update-assignment.dto';
import { DeleteAssignmentsDto } from './dto/delete-assignments.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { Role } from '@prisma/client';

@ApiTags('Assignments')
@ApiBearerAuth()
@Controller('assignments')
export class AssignmentsController {
  constructor(private readonly assignmentsService: AssignmentsService) {}

  @Get('client-options')
  @ApiOperation({
    summary: 'Get lightweight client options for assignment planning',
  })
  @ApiOkResponse({ description: 'Visible client options fetched successfully' })
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  getClientOptions(@CurrentUser() user: AuthenticatedUser) {
    return this.assignmentsService.getClientOptions(user);
  }

  @Get('catalog-options')
  @ApiOperation({
    summary:
      'Get lightweight training and diet options for assignment planning',
  })
  @ApiOkResponse({
    description: 'Assignment catalog options fetched successfully',
  })
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  getCatalogOptions() {
    return this.assignmentsService.getCatalogOptions();
  }

  @Post('auto-rules')
  @ApiOperation({ summary: 'Create or replace the active weekly auto-assignment rule' })
  @ApiOkResponse({ description: 'Auto-assignment rule saved successfully' })
  @ApiBadRequestResponse({ description: 'Invalid auto-assignment payload' })
  @ApiForbiddenResponse({ description: 'Client does not belong to the current admin' })
  @ApiNotFoundResponse({ description: 'Client, training, or diet not found' })
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  createAutoRule(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateAutoAssignmentRuleDto,
  ) {
    return this.assignmentsService.createAutoRule(user, dto);
  }

  @Put('auto-rules/:id')
  @ApiOperation({ summary: 'Update the active weekly auto-assignment rule in place' })
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  updateAutoRule(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateAutoAssignmentRuleDto,
  ) {
    return this.assignmentsService.updateAutoRule(user, id, dto);
  }

  @Get('auto-rules/active')
  @ApiOperation({ summary: 'Get the active weekly auto-assignment rule for a client' })
  @ApiOkResponse({ description: 'Active auto-assignment rule fetched successfully' })
  @ApiForbiddenResponse({ description: 'Client does not belong to the current admin' })
  @ApiNotFoundResponse({ description: 'Client not found' })
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  getActiveAutoRule(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: GetActiveAutoAssignmentRuleQueryDto,
  ) {
    return this.assignmentsService.getActiveAutoRule(user, query);
  }

  @Put('auto-rules/:id/deactivate')
  @ApiOperation({ summary: 'Deactivate a weekly auto-assignment rule' })
  @ApiOkResponse({ description: 'Auto-assignment rule deactivated successfully' })
  @ApiForbiddenResponse({ description: 'Client does not belong to the current admin' })
  @ApiNotFoundResponse({ description: 'Auto-assignment rule not found' })
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  deactivateAutoRule(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.assignmentsService.deactivateAutoRule(user, id);
  }

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

  @Post('copy-selection')
  @ApiOperation({ summary: 'Copy selected assignment days preserving relative offsets' })
  @ApiOkResponse({ description: 'Selected days copied successfully' })
  @ApiBadRequestResponse({ description: 'Invalid source or target dates' })
  @ApiForbiddenResponse({ description: 'Client does not belong to the current admin' })
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  copySelection(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CopySelectionDto,
  ) {
    return this.assignmentsService.copySelection(user, dto);
  }

  @Post('delete-batch')
  @ApiOperation({ summary: 'Delete multiple assignment days' })
  @ApiOkResponse({ description: 'Assignments deleted successfully' })
  @ApiBadRequestResponse({ description: 'Invalid assignment identifiers' })
  @ApiForbiddenResponse({ description: 'Client does not belong to the current admin' })
  @ApiNotFoundResponse({ description: 'One or more assignments were not found' })
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  deleteBatch(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: DeleteAssignmentsDto,
  ) {
    return this.assignmentsService.deleteAssignments(user, dto.assignment_ids);
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
