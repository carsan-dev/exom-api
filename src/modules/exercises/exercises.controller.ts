import {
  Controller,
  Get,
  Post,
  Put,
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
  ApiResponse,
} from '@nestjs/swagger';
import { ExercisesService } from './exercises.service';
import { CreateExerciseDto, UpdateExerciseDto } from './dto/create-exercise.dto';
import { PaginationDto } from '../../common/dto/pagination.dto';
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
  @ApiOperation({ summary: 'List all active exercises (paginated)' })
  findAll(@Query() pagination: PaginationDto) {
    return this.exercisesService.findAll(pagination);
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
  @ApiResponse({ status: 202, description: 'Solicitud de aprobación creada (solo ADMIN)' })
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
  @ApiResponse({ status: 202, description: 'Solicitud de aprobación creada (solo ADMIN)' })
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Param('id') id: string,
    @CurrentUser() _user: AuthenticatedUser,
  ) {
    return this.exercisesService.remove(id);
  }
}
