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
  ApiOkResponse,
} from '@nestjs/swagger';
import { TrainingsService } from './trainings.service';
import { CreateTrainingDto, UpdateTrainingDto } from './dto/create-training.dto';
import { TrainingTagsResponseDto } from './dto/training-tags-response.dto';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { Role } from '@prisma/client';

@ApiTags('Trainings')
@ApiBearerAuth()
@Controller('trainings')
export class TrainingsController {
  constructor(private readonly trainingsService: TrainingsService) {}

  @Get()
  @ApiOperation({ summary: 'List all active trainings (paginated)' })
  findAll(@Query() pagination: PaginationDto) {
    return this.trainingsService.findAll(pagination);
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
  @ApiOperation({ summary: 'Update a training (admin only)' })
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  update(@Param('id') id: string, @Body() dto: UpdateTrainingDto) {
    return this.trainingsService.update(id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Soft-delete a training (admin only)' })
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string) {
    return this.trainingsService.remove(id);
  }
}
