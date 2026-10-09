import {
  BadRequestException,
  Body,
  CallHandler,
  Controller,
  ExecutionContext,
  Get,
  Injectable,
  NestInterceptor,
  Param,
  Post,
  Put,
  Query,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { ClientFollowUpTasksService } from './client-followup-tasks.service';
import {
  CreateClientFollowUpTaskDto,
  UpdateClientFollowUpTaskDto,
} from './dto/client-followup-task.dto';

import {
  ClientFollowUpTaskListDto,
  FollowUpPageDto,
} from './dto/client-followup-task-list.dto';

@Injectable()
class RejectTaskPrototypeFields implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler<unknown>) {
    const { body, query } = context.switchToHttp().getRequest<{
      body?: unknown;
      query?: Record<string, unknown>;
    }>();
    if (
      ['list', 'assignees'].includes(context.getHandler().name) &&
      query &&
      (['__proto__', 'constructor', 'prototype'].some((key) =>
        Object.hasOwn(query, key),
      ) ||
        Object.values(query).some((value) => typeof value !== 'string'))
    ) {
      throw new BadRequestException('Invalid task query');
    }
    // ValidationPipe/class-transformer strips these keys before whitelist checks.
    // Reject the raw request instead of silently accepting malicious extras.
    if (
      body &&
      typeof body === 'object' &&
      ['__proto__', 'constructor', 'prototype'].some((key) =>
        Object.hasOwn(body, key),
      )
    ) {
      throw new BadRequestException('Unknown task field');
    }
    return next.handle();
  }
}

@ApiTags('Admin - Follow-up Tasks')
@ApiBearerAuth()
@Controller('admin/clients/:clientId/follow-up-tasks')
@Roles(Role.ADMIN, Role.SUPER_ADMIN)
@UseInterceptors(RejectTaskPrototypeFields)
export class ClientFollowUpTasksController {
  constructor(private readonly tasks: ClientFollowUpTasksService) {}

  @Get('summary')
  @ApiOperation({
    summary: 'Read canonical next task and review as of today UTC',
  })
  summary(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('clientId') clientId: string,
  ) {
    // No body/query clock or owner input: route and server clock are authoritative.
    return this.tasks.summary(clientId, actor);
  }

  @Get()
  @ApiOperation({
    summary: 'List internal tasks; defaults to active, never assignee-only',
  })
  list(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('clientId') clientId: string,
    @Query() query: ClientFollowUpTaskListDto,
  ) {
    return this.tasks.list(clientId, actor, query);
  }

  @Get('assignees')
  @ApiOperation({
    summary:
      'List eligible task assignees for this client, not assignment-management access',
  })
  assignees(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('clientId') clientId: string,
    @Query() query: FollowUpPageDto,
  ) {
    return this.tasks.assignees(clientId, actor, query);
  }

  @Get(':taskId')
  @ApiOperation({ summary: 'Read an internal manual task without changing it' })
  get(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('clientId') clientId: string,
    @Param('taskId') taskId: string,
  ) {
    return this.tasks.get(clientId, taskId, actor);
  }

  @Post()
  @ApiOperation({ summary: 'Create or replay an internal manual task by UUID' })
  create(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('clientId') clientId: string,
    @Body() dto: CreateClientFollowUpTaskDto,
  ) {
    return this.tasks.create(clientId, dto, actor);
  }

  @Put(':taskId')
  @ApiOperation({
    summary: 'Edit, complete or cancel an open task at an explicit version',
  })
  update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('clientId') clientId: string,
    @Param('taskId') taskId: string,
    @Body() dto: UpdateClientFollowUpTaskDto,
  ) {
    return this.tasks.update(clientId, taskId, dto, actor);
  }
}
