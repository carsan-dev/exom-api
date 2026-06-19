import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';
import { CreateCatalogGroupDto, UpdateCatalogGroupDto } from '../../common/catalog-groups/dto/catalog-group.dto';
import { DietGroupsService } from './diet-groups.service';

@ApiTags('Diet groups')
@ApiBearerAuth()
@Roles(Role.ADMIN, Role.SUPER_ADMIN)
@Controller('diet-groups')
export class DietGroupsController {
  constructor(private readonly groups: DietGroupsService) {}
  @Get() findAll() { return this.groups.findAll(); }
  @Post() create(@Body() dto: CreateCatalogGroupDto) { return this.groups.create(dto.name); }
  @Patch(':id') update(@Param('id') id: string, @Body() dto: UpdateCatalogGroupDto) {
    return this.groups.update(id, dto.name ?? '');
  }
  @Delete(':id') @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string) { return this.groups.remove(id); }
}
