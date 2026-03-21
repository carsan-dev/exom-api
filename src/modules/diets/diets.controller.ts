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
} from '@nestjs/swagger';
import { DietsService } from './diets.service';
import { CreateDietDto, UpdateDietDto } from './dto/create-diet.dto';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { Role } from '@prisma/client';

@ApiTags('Diets')
@ApiBearerAuth()
@Controller('diets')
export class DietsController {
  constructor(private readonly dietsService: DietsService) {}

  @Get()
  @ApiOperation({ summary: 'List all active diets (paginated)' })
  findAll(@Query() pagination: PaginationDto) {
    return this.dietsService.findAll(pagination);
  }

  // NOTE: /today MUST be declared before /:id to avoid routing conflicts
  @Get('today')
  @ApiOperation({ summary: "Get today's diet for the current client" })
  @Roles(Role.CLIENT)
  findToday(@CurrentUser() user: AuthenticatedUser) {
    return this.dietsService.findToday(user.id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single diet by ID' })
  findOne(@Param('id') id: string) {
    return this.dietsService.findOne(id);
  }

  @Post()
  @ApiOperation({ summary: 'Create a new diet with meals (admin only)' })
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateDietDto,
  ) {
    return this.dietsService.create(user.id, dto);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update a diet (admin only)' })
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  update(@Param('id') id: string, @Body() dto: UpdateDietDto) {
    return this.dietsService.update(id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Soft-delete a diet (admin only)' })
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string) {
    return this.dietsService.remove(id);
  }
}
