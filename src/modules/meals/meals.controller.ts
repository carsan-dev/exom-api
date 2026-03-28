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
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Create a meal inside a diet' })
  @ApiResponse({ status: 201, description: 'Meal created successfully' })
  create(@Body() dto: CreateMealBodyDto) {
    return this.mealsService.createFromBody(dto);
  }

  @Put(':id')
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Update meal name, macros and ingredients' })
  update(@Param('id') id: string, @Body() dto: UpdateMealDto) {
    return this.mealsService.updateFromDto(id, dto);
  }

  @Delete(':id')
  @Roles(Role.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a meal' })
  remove(@Param('id') id: string) {
    return this.mealsService.remove(id);
  }
}
