import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { MealsService } from './meals.service';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { RequiresApproval } from '../../common/decorators/requires-approval.decorator';
import { Role } from '@prisma/client';
import { CreateMealBodyDto } from './dto/create-meal.dto';
import { UpdateMealDto } from './dto/update-meal.dto';

@ApiTags('Meals')
@ApiBearerAuth()
@Controller('meals')
export class MealsController {
  constructor(private readonly mealsService: MealsService) {}

  @Get(':id')
  @Roles(Role.ADMIN, Role.CLIENT)
  @ApiOperation({ summary: 'Get a single meal with ingredients by ID' })
  findOne(@Param('id') id: string) {
    return this.mealsService.findOne(id);
  }

  @Post()
  @RequiresApproval('meal.create', 'meal')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Create a meal inside a diet' })
  @ApiResponse({ status: 201, description: 'Meal created successfully' })
  @ApiResponse({ status: 202, description: 'Solicitud de aprobación creada (solo ADMIN)' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateMealBodyDto,
  ) {
    return this.mealsService.createFromBody(dto, user.id);
  }

  @Put(':id')
  @RequiresApproval('meal.update', 'meal')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Update meal name, macros and ingredients' })
  @ApiResponse({ status: 202, description: 'Solicitud de aprobación creada (solo ADMIN)' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateMealDto,
  ) {
    return this.mealsService.updateFromDto(id, dto, user.id);
  }

  @Delete(':id')
  @RequiresApproval('meal.delete', 'meal')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a meal' })
  @ApiResponse({ status: 202, description: 'Solicitud de aprobación creada (solo ADMIN)' })
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.mealsService.removeWithAuth(id, user.id);
  }
}
