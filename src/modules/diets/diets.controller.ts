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
  ApiBadRequestResponse,
  ApiCreatedResponse,
  ApiTags,
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiOkResponse,
  ApiResponse,
} from '@nestjs/swagger';
import { DietsService } from './diets.service';
import { CreateDietDto, UpdateDietDto } from './dto/create-diet.dto';
import { DietNutritionalBadgesResponseDto } from './dto/diet-nutritional-badges-response.dto';
import { DietTagsResponseDto } from './dto/diet-tags-response.dto';
import { DietsQueryDto } from './dto/diets-query.dto';
import { FindTodayDietQueryDto } from './dto/find-today-diet-query.dto';
import { FindWeekDietQueryDto } from './dto/find-week-diet-query.dto';
import {
  CatalogMutationResponseDto,
  RenameCatalogValueDto,
} from '../../common/dto/catalog-value.dto';
import {
  CatalogColorMutationResponseDto,
  UpdateCatalogColorDto,
} from '../../common/dto/catalog-color.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { RequiresApproval } from '../../common/decorators/requires-approval.decorator';
import { Role } from '@prisma/client';
import { UpdateDietGroupMembershipDto } from '../../common/catalog-groups/dto/catalog-group.dto';

@ApiTags('Diets')
@ApiBearerAuth()
@Controller('diets')
export class DietsController {
  constructor(private readonly dietsService: DietsService) {}

  @Get()
  @ApiOperation({
    summary: 'List active diets for the admin catalog (paginated)',
  })
  @ApiOkResponse({ description: 'Diets listed successfully' })
  @ApiBadRequestResponse({ description: 'Invalid pagination parameters' })
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  findAll(@Query() query: DietsQueryDto) {
    return this.dietsService.findAll(query);
  }

  @Patch('group-membership')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  updateGroupMembership(@Body() dto: UpdateDietGroupMembershipDto) {
    return this.dietsService.updateGroupMembership(dto.diet_ids, dto.group_id);
  }

  // NOTE: /today MUST be declared before /:id to avoid routing conflicts
  @Get('today')
  @ApiOperation({
    summary: 'Get the diet assigned to the current client for a given date',
  })
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

  @Get('week')
  @ApiOperation({
    summary: 'Get the diets assigned to the current client for one week',
  })
  @ApiOkResponse({ description: 'Weekly diets fetched successfully' })
  @ApiBadRequestResponse({ description: 'Invalid week_start parameter' })
  @Roles(Role.CLIENT)
  findWeek(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: FindWeekDietQueryDto,
  ) {
    return this.dietsService.findWeek(user.id, new Date(query.week_start));
  }

  @Get('nutritional-badges')
  @ApiOperation({
    summary: 'List all unique nutritional badges used by active diets',
  })
  @ApiOkResponse({ type: DietNutritionalBadgesResponseDto })
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  findAllNutritionalBadges() {
    return this.dietsService.findAllNutritionalBadges();
  }

  @Get('tags')
  @ApiOperation({
    summary: 'List all unique tags used by active diets',
  })
  @ApiOkResponse({ type: DietTagsResponseDto })
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  findAllTags() {
    return this.dietsService.findAllTags();
  }

  @Patch('nutritional-badges/rename')
  @ApiOperation({
    summary: 'Rename a nutritional badge across active diet meals',
  })
  @ApiOkResponse({ type: CatalogMutationResponseDto })
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  renameNutritionalBadge(@Body() dto: RenameCatalogValueDto) {
    return this.dietsService.renameNutritionalBadge(dto.from, dto.to);
  }

  @Patch('nutritional-badges/:value/color')
  @ApiOperation({
    summary: 'Update the display color for a nutritional badge',
  })
  @ApiOkResponse({ type: CatalogColorMutationResponseDto })
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  updateNutritionalBadgeColor(
    @Param('value') value: string,
    @Body() dto: UpdateCatalogColorDto,
  ) {
    return this.dietsService.updateNutritionalBadgeColor(value, dto.color);
  }

  @Delete('nutritional-badges/:value')
  @ApiOperation({
    summary: 'Remove a nutritional badge from all active diet meals',
  })
  @ApiOkResponse({ type: CatalogMutationResponseDto })
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  deleteNutritionalBadge(@Param('value') value: string) {
    return this.dietsService.deleteNutritionalBadge(value);
  }

  @Patch('tags/rename')
  @ApiOperation({ summary: 'Rename a tag across active diets' })
  @ApiOkResponse({ type: CatalogMutationResponseDto })
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  renameTag(@Body() dto: RenameCatalogValueDto) {
    return this.dietsService.renameTag(dto.from, dto.to);
  }

  @Delete('tags/:value')
  @ApiOperation({ summary: 'Remove a tag from all active diets' })
  @ApiOkResponse({ type: CatalogMutationResponseDto })
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  deleteTag(@Param('value') value: string) {
    return this.dietsService.deleteTag(value);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get diet detail from the admin catalog' })
  @ApiOkResponse({ description: 'Diet fetched successfully' })
  @ApiBadRequestResponse({ description: 'Invalid diet identifier' })
  @ApiNotFoundResponse({ description: 'Diet not found' })
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  findOne(@Param('id') id: string) {
    return this.dietsService.findOne(id);
  }

  @Post()
  @ApiOperation({ summary: 'Create a diet with meals and ingredients' })
  @ApiCreatedResponse({ description: 'Diet created successfully' })
  @ApiBadRequestResponse({ description: 'Invalid diet payload' })
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateDietDto) {
    return this.dietsService.create(user.id, dto);
  }

  @Put(':id')
  @RequiresApproval('diet.update', 'diet')
  @ApiOperation({ summary: 'Update a complete diet from the admin catalog' })
  @ApiOkResponse({ description: 'Diet updated successfully' })
  @ApiResponse({
    status: 202,
    description: 'Solicitud de aprobación creada (solo ADMIN)',
  })
  @ApiBadRequestResponse({ description: 'Invalid diet payload' })
  @ApiNotFoundResponse({ description: 'Diet not found' })
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  update(
    @Param('id') id: string,
    @Body() dto: UpdateDietDto,
    @CurrentUser() _user: AuthenticatedUser,
  ) {
    return this.dietsService.update(id, dto);
  }

  @Delete(':id')
  @RequiresApproval('diet.delete', 'diet')
  @ApiOperation({ summary: 'Soft-delete a diet from the admin catalog' })
  @ApiNoContentResponse({ description: 'Diet deleted successfully' })
  @ApiResponse({
    status: 202,
    description: 'Solicitud de aprobación creada (solo ADMIN)',
  })
  @ApiBadRequestResponse({ description: 'Invalid diet identifier' })
  @ApiNotFoundResponse({ description: 'Diet not found' })
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string, @CurrentUser() _user: AuthenticatedUser) {
    return this.dietsService.remove(id);
  }
}
