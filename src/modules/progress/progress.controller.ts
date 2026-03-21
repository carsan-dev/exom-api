import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
} from '@nestjs/swagger';
import { ProgressService } from './progress.service';
import { MarkExerciseDto, MarkMealDto } from './dto/mark-completed.dto';
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
  @ApiQuery({ name: 'date', required: true, type: String, description: 'YYYY-MM-DD' })
  getDayProgress(
    @CurrentUser() user: AuthenticatedUser,
    @Query('date') date: string,
  ) {
    return this.progressService.getDayProgress(user.id, date);
  }

  @Post('exercises/complete')
  @ApiOperation({ summary: 'Mark an exercise as completed' })
  markExerciseCompleted(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: MarkExerciseDto,
  ) {
    return this.progressService.markExerciseCompleted(user.id, dto);
  }

  @Delete('exercises/:exerciseId')
  @ApiOperation({ summary: 'Unmark an exercise as completed' })
  @ApiQuery({ name: 'date', required: true, type: String, description: 'YYYY-MM-DD' })
  unmarkExercise(
    @CurrentUser() user: AuthenticatedUser,
    @Param('exerciseId') exerciseId: string,
    @Query('date') date: string,
  ) {
    return this.progressService.unmarkExercise(user.id, date, exerciseId);
  }

  @Post('meals/complete')
  @ApiOperation({ summary: 'Mark a meal as completed' })
  markMealCompleted(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: MarkMealDto,
  ) {
    return this.progressService.markMealCompleted(user.id, dto);
  }

  @Delete('meals/:mealId')
  @ApiOperation({ summary: 'Unmark a meal as completed' })
  @ApiQuery({ name: 'date', required: true, type: String, description: 'YYYY-MM-DD' })
  unmarkMeal(
    @CurrentUser() user: AuthenticatedUser,
    @Param('mealId') mealId: string,
    @Query('date') date: string,
  ) {
    return this.progressService.unmarkMeal(user.id, date, mealId);
  }
}
