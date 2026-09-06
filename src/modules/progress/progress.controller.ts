import { runProgressCommand } from '../../common/progress/progress-command';
import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  Headers,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
} from '@nestjs/swagger';
import { ProgressService } from './progress.service';
import {
  CompleteTrainingDto,
  MarkExerciseDto,
  MarkMealDto,
} from './dto/mark-completed.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { Role } from '@prisma/client';

@ApiTags('Progress')
@ApiBearerAuth()
@Controller('progress')
@Roles(Role.CLIENT)
export class ProgressController {
  constructor(private readonly progressService: ProgressService) {}

  @Get()
  @ApiOperation({ summary: "Get client's day progress for a given date" })
  @ApiQuery({
    name: 'date',
    required: true,
    type: String,
    description: 'YYYY-MM-DD',
  })
  getDayProgress(
    @CurrentUser() user: AuthenticatedUser,
    @Query('date') date: string,
  ) {
    return this.progressService.getDayProgress(user.id, date);
  }

  @Get('exercises/previous')
  @ApiOperation({ summary: 'Get previous recorded exercise performances' })
  @ApiQuery({
    name: 'exercise_ids',
    required: true,
    type: String,
    description: 'Comma-separated exercise ids',
  })
  @ApiQuery({
    name: 'before',
    required: true,
    type: String,
    description: 'YYYY-MM-DD',
  })
  getPreviousExercisePerformances(
    @CurrentUser() user: AuthenticatedUser,
    @Query('exercise_ids') exerciseIds: string,
    @Query('before') before: string,
  ): Promise<Record<string, unknown>> {
    return this.progressService.getPreviousExercisePerformances(
      user.id,
      exerciseIds,
      before,
    );
  }

  @Post('exercises/complete')
  @ApiOperation({ summary: 'Mark an exercise as completed' })
  markExerciseCompleted(
    @Headers('x-exom-operation-id') operationId: string | undefined,
    @Headers('x-exom-revision') revision: string | undefined,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: MarkExerciseDto,
  ) {
    return runProgressCommand(
      operationId,
      revision,
      ['markExerciseCompleted', dto],
      () => this.progressService.markExerciseCompleted(user.id, dto),
    );
  }

  @Post('trainings/complete')
  @ApiOperation({ summary: 'Mark the assigned training as completed' })
  completeTraining(
    @Headers('x-exom-operation-id') operationId: string | undefined,
    @Headers('x-exom-revision') revision: string | undefined,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CompleteTrainingDto,
  ) {
    return runProgressCommand(
      operationId,
      revision,
      ['completeTraining', dto],
      () => this.progressService.completeTraining(user.id, dto),
    );
  }

  @Delete('exercises/:exerciseId')
  @ApiOperation({ summary: 'Unmark an exercise as completed' })
  @ApiQuery({
    name: 'date',
    required: true,
    type: String,
    description: 'YYYY-MM-DD',
  })
  unmarkExercise(
    @Headers('x-exom-operation-id') operationId: string | undefined,
    @Headers('x-exom-revision') revision: string | undefined,
    @CurrentUser() user: AuthenticatedUser,
    @Param('exerciseId') exerciseId: string,
    @Query('date') date: string,
  ) {
    return runProgressCommand(
      operationId,
      revision,
      ['unmarkExercise', date, exerciseId],
      () => this.progressService.unmarkExercise(user.id, date, exerciseId),
    );
  }

  @Post('meals/complete')
  @ApiOperation({ summary: 'Mark a meal as completed' })
  markMealCompleted(
    @Headers('x-exom-operation-id') operationId: string | undefined,
    @Headers('x-exom-revision') revision: string | undefined,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: MarkMealDto,
  ) {
    return runProgressCommand(
      operationId,
      revision,
      ['markMealCompleted', dto],
      () => this.progressService.markMealCompleted(user.id, dto),
    );
  }

  @Delete('meals/:mealId')
  @ApiOperation({ summary: 'Unmark a meal as completed' })
  @ApiQuery({
    name: 'date',
    required: true,
    type: String,
    description: 'YYYY-MM-DD',
  })
  unmarkMeal(
    @Headers('x-exom-operation-id') operationId: string | undefined,
    @Headers('x-exom-revision') revision: string | undefined,
    @CurrentUser() user: AuthenticatedUser,
    @Param('mealId') mealId: string,
    @Query('date') date: string,
  ) {
    return runProgressCommand(
      operationId,
      revision,
      ['unmarkMeal', date, mealId],
      () => this.progressService.unmarkMeal(user.id, date, mealId),
    );
  }
}
