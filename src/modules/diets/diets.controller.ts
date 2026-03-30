import {
  ParseUUIDPipe,
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
  ApiBadRequestResponse,
  ApiCreatedResponse,
  ApiTags,
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiOkResponse,
} from '@nestjs/swagger';
import { DietsService } from './diets.service';
import { CreateDietDto, UpdateDietDto } from './dto/create-diet.dto';
import { FindTodayDietQueryDto } from './dto/find-today-diet-query.dto';
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
  @ApiOperation({ summary: 'List active diets for the admin catalog (paginated)' })
  @ApiOkResponse({ description: 'Diets listed successfully' })
  @ApiBadRequestResponse({ description: 'Invalid pagination parameters' })
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  findAll(@Query() pagination: PaginationDto) {
    return this.dietsService.findAll(pagination);
  }

  // NOTE: /today MUST be declared before /:id to avoid routing conflicts
  @Get('today')
  @ApiOperation({ summary: 'Get the diet assigned to the current client for a given date' })
  @ApiOkResponse({ description: 'Assigned diet fetched successfully' })
  @ApiBadRequestResponse({ description: 'Invalid date parameter' })
  @Roles(Role.CLIENT)
  findToday(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: FindTodayDietQueryDto,
  ) {
    const date = query.date ? new Date(query.date) : undefined;
    return this.dietsService.findToday(user.id, date);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get diet detail from the admin catalog' })
  @ApiOkResponse({ description: 'Diet fetched successfully' })
  @ApiBadRequestResponse({ description: 'Invalid diet identifier' })
  @ApiNotFoundResponse({ description: 'Diet not found' })
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.dietsService.findOne(id);
  }

  @Post()
  @ApiOperation({ summary: 'Create a diet with meals and ingredients' })
  @ApiCreatedResponse({ description: 'Diet created successfully' })
  @ApiBadRequestResponse({ description: 'Invalid diet payload' })
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateDietDto,
  ) {
    return this.dietsService.create(user.id, dto);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update a complete diet from the admin catalog' })
  @ApiOkResponse({ description: 'Diet updated successfully' })
  @ApiBadRequestResponse({ description: 'Invalid diet payload' })
  @ApiNotFoundResponse({ description: 'Diet not found' })
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateDietDto) {
    return this.dietsService.update(id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Soft-delete a diet from the admin catalog' })
  @ApiNoContentResponse({ description: 'Diet deleted successfully' })
  @ApiBadRequestResponse({ description: 'Invalid diet identifier' })
  @ApiNotFoundResponse({ description: 'Diet not found' })
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.dietsService.remove(id);
  }
}
