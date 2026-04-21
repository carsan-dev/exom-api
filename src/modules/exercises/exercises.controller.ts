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
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { ExercisesService } from './exercises.service';
import {
  CreateExerciseDto,
  UpdateExerciseDto,
} from './dto/create-exercise.dto';
import { ExerciseMuscleGroupsResponseDto } from './dto/exercise-muscle-groups-response.dto';
import { ExerciseEquipmentResponseDto } from './dto/exercise-equipment-response.dto';
import { ExercisesQueryDto } from './dto/exercises-query.dto';
import {
  CatalogMutationResponseDto,
  RenameCatalogValueDto,
} from '../../common/dto/catalog-value.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RequiresApproval } from '../../common/decorators/requires-approval.decorator';
import { Role } from '@prisma/client';

@ApiTags('Exercises')
@ApiBearerAuth()
@Controller('exercises')
export class ExercisesController {
  constructor(private readonly exercisesService: ExercisesService) {}

  @Get()
  @ApiOperation({ summary: 'List all active exercises with optional search' })
  findAll(@Query() query: ExercisesQueryDto) {
    return this.exercisesService.findAll(query.search, query);
  }

  // NOTE: static routes (/muscle-groups, /equipment) MUST be declared before /:id
  @Get('muscle-groups')
  @ApiOperation({
    summary: 'List all unique muscle groups used by active exercises',
  })
  @ApiOkResponse({ type: ExerciseMuscleGroupsResponseDto })
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  findAllMuscleGroups() {
    return this.exercisesService.findAllMuscleGroups();
  }

  @Patch('muscle-groups/rename')
  @ApiOperation({
    summary: 'Rename a muscle group across active exercises',
  })
  @ApiOkResponse({ type: CatalogMutationResponseDto })
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  renameMuscleGroup(@Body() dto: RenameCatalogValueDto) {
    return this.exercisesService.renameMuscleGroup(dto.from, dto.to);
  }

  @Delete('muscle-groups/:value')
  @ApiOperation({
    summary: 'Remove a muscle group from all active exercises',
  })
  @ApiOkResponse({ type: CatalogMutationResponseDto })
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  deleteMuscleGroup(@Param('value') value: string) {
    return this.exercisesService.deleteMuscleGroup(value);
  }

  @Get('equipment')
  @ApiOperation({
    summary: 'List all unique equipment used by active exercises',
  })
  @ApiOkResponse({ type: ExerciseEquipmentResponseDto })
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  findAllEquipment() {
    return this.exercisesService.findAllEquipment();
  }

  @Patch('equipment/rename')
  @ApiOperation({
    summary: 'Rename equipment across active exercises',
  })
  @ApiOkResponse({ type: CatalogMutationResponseDto })
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  renameEquipment(@Body() dto: RenameCatalogValueDto) {
    return this.exercisesService.renameEquipment(dto.from, dto.to);
  }

  @Delete('equipment/:value')
  @ApiOperation({
    summary: 'Remove equipment from all active exercises',
  })
  @ApiOkResponse({ type: CatalogMutationResponseDto })
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  deleteEquipment(@Param('value') value: string) {
    return this.exercisesService.deleteEquipment(value);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single exercise by ID' })
  findOne(@Param('id') id: string) {
    return this.exercisesService.findOne(id);
  }

  @Post()
  @ApiOperation({ summary: 'Create a new exercise (admin only)' })
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  create(
    @Body() dto: CreateExerciseDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.exercisesService.create(dto, user.id);
  }

  @Put(':id')
  @RequiresApproval('exercise.update', 'exercise')
  @ApiOperation({ summary: 'Update an exercise (admin only)' })
  @ApiResponse({
    status: 202,
    description: 'Solicitud de aprobación creada (solo ADMIN)',
  })
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  update(
    @Param('id') id: string,
    @Body() dto: UpdateExerciseDto,
    @CurrentUser() _user: AuthenticatedUser,
  ) {
    return this.exercisesService.update(id, dto);
  }

  @Delete(':id')
  @RequiresApproval('exercise.delete', 'exercise')
  @ApiOperation({ summary: 'Soft-delete an exercise (admin only)' })
  @ApiResponse({
    status: 202,
    description: 'Solicitud de aprobación creada (solo ADMIN)',
  })
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string, @CurrentUser() _user: AuthenticatedUser) {
    return this.exercisesService.remove(id);
  }
}
