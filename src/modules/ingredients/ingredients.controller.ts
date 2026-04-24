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
import { IngredientsService } from './ingredients.service';
import {
  CreateIngredientDto,
  UpdateIngredientDto,
} from './dto/create-ingredient.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RequiresApproval } from '../../common/decorators/requires-approval.decorator';
import { Role } from '@prisma/client';
import { IngredientsQueryDto } from './dto/ingredients-query.dto';

@ApiTags('Ingredients')
@ApiBearerAuth()
@Controller('ingredients')
export class IngredientsController {
  constructor(private readonly ingredientsService: IngredientsService) {}

  @Get()
  @ApiOperation({ summary: 'List ingredients with optional search' })
  findAll(@Query() query: IngredientsQueryDto) {
    return this.ingredientsService.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single ingredient by ID' })
  findOne(@Param('id') id: string) {
    return this.ingredientsService.findOne(id);
  }

  @Post()
  @ApiOperation({ summary: 'Create a new ingredient (admin only)' })
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  create(
    @Body() dto: CreateIngredientDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.ingredientsService.create(dto, user.id);
  }

  @Put(':id')
  @RequiresApproval('ingredient.update', 'ingredient')
  @ApiOperation({ summary: 'Update an ingredient (admin only)' })
  @ApiResponse({ status: 202, description: 'Solicitud de aprobación creada (solo ADMIN)' })
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  update(
    @Param('id') id: string,
    @Body() dto: UpdateIngredientDto,
    @CurrentUser() _user: AuthenticatedUser,
  ) {
    return this.ingredientsService.update(id, dto);
  }

  @Delete(':id')
  @RequiresApproval('ingredient.delete', 'ingredient')
  @ApiOperation({ summary: 'Soft-delete an ingredient (admin only)' })
  @ApiResponse({ status: 202, description: 'Solicitud de aprobación creada (solo ADMIN)' })
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Param('id') id: string,
    @CurrentUser() _user: AuthenticatedUser,
  ) {
    return this.ingredientsService.remove(id);
  }
}
