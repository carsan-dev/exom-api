import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiOkResponse,
  ApiResponse,
} from '@nestjs/swagger';
import { TrainingsService } from './trainings.service';
import { CreateTrainingDto, UpdateTrainingDto } from './dto/create-training.dto';
import { TrainingTagsResponseDto } from './dto/training-tags-response.dto';
import { TrainingsQueryDto } from './dto/trainings-query.dto';
import {
  CatalogMutationResponseDto,
  RenameCatalogValueDto,
} from '../../common/dto/catalog-value.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { RequiresApproval } from '../../common/decorators/requires-approval.decorator';
import { Role } from '@prisma/client';

@ApiTags('Trainings')
@ApiBearerAuth()
@Controller('trainings')
export class TrainingsController {
  constructor(private readonly trainingsService: TrainingsService) {}

  @Get()
  @ApiOperation({ summary: 'List all active trainings with optional search' })
  findAll(@Query() query: TrainingsQueryDto) {
    return this.trainingsService.findAll(query.search, query);
  }

  // NOTE: /today MUST be declared before /:id to avoid routing conflicts
  @Get('today')
  @ApiOperation({ summary: "Get training for the current client on a given date (defaults to today)" })
  @Roles(Role.CLIENT)
  findToday(
    @CurrentUser() user: AuthenticatedUser,
    @Query('date') dateStr?: string,
  ) {
    const date = dateStr ? new Date(dateStr) : undefined;
    return this.trainingsService.findToday(user.id, date);
  }

  @Get('tags')
  @ApiOperation({ summary: 'List all unique tags used by active trainings' })
  @ApiOkResponse({ type: TrainingTagsResponseDto })
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  findAllTags() {
    return this.trainingsService.findAllTags();
  }

  @Patch('tags/rename')
  @ApiOperation({ summary: 'Rename a tag across active trainings' })
  @ApiOkResponse({ type: CatalogMutationResponseDto })
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  renameTag(@Body() dto: RenameCatalogValueDto) {
    return this.trainingsService.renameTag(dto.from, dto.to);
  }

  @Delete('tags/:value')
  @ApiOperation({ summary: 'Remove a tag from all active trainings' })
  @ApiOkResponse({ type: CatalogMutationResponseDto })
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  deleteTag(@Param('value') value: string) {
    return this.trainingsService.deleteTag(value);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single training by ID' })
  findOne(@Param('id') id: string) {
    return this.trainingsService.findOne(id);
  }

  @Post()
  @ApiOperation({ summary: 'Create a new training (admin only)' })
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateTrainingDto,
  ) {
    return this.trainingsService.create(user.id, dto);
  }

  @Put(':id')
  @RequiresApproval('training.update', 'training')
  @ApiOperation({ summary: 'Update a training (admin only)' })
  @ApiResponse({ status: 202, description: 'Solicitud de aprobación creada (solo ADMIN)' })
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  update(
    @Param('id') id: string,
    @Body() dto: UpdateTrainingDto,
    @CurrentUser() _user: AuthenticatedUser,
  ) {
    return this.trainingsService.update(id, dto);
  }

  @Delete(':id')
  @RequiresApproval('training.delete', 'training')
  @ApiOperation({ summary: 'Soft-delete a training (admin only)' })
  @ApiResponse({ status: 202, description: 'Solicitud de aprobación creada (solo ADMIN)' })
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Param('id') id: string,
    @CurrentUser() _user: AuthenticatedUser,
  ) {
    return this.trainingsService.remove(id);
  }
}
