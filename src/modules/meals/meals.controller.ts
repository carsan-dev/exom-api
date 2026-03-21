import { Controller, Get, Param } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { MealsService } from './meals.service';

@ApiTags('Meals')
@ApiBearerAuth()
@Controller('meals')
export class MealsController {
  constructor(private readonly mealsService: MealsService) {}

  @Get(':id')
  @ApiOperation({ summary: 'Get a single meal with ingredients by ID' })
  findOne(@Param('id') id: string) {
    return this.mealsService.findOne(id);
  }
}
