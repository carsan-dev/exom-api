import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';
import { CreateCatalogGroupDto, UpdateCatalogGroupDto } from '../../common/catalog-groups/dto/catalog-group.dto';
import { TrainingGroupsService } from './training-groups.service';

@ApiTags('Training groups')
@ApiBearerAuth()
@Roles(Role.ADMIN, Role.SUPER_ADMIN)
@Controller('training-groups')
export class TrainingGroupsController {
  constructor(private readonly groups: TrainingGroupsService) {}

  @Get()
  findAll() { return this.groups.findAll(); }

  @Post()
  create(@Body() dto: CreateCatalogGroupDto) { return this.groups.create(dto.name); }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateCatalogGroupDto) {
    return this.groups.update(id, dto.name ?? '');
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete group; members remain ungrouped' })
  remove(@Param('id') id: string) { return this.groups.remove(id); }
}
