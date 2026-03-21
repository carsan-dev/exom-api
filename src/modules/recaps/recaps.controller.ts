import { Controller, Get, Post, Put, Body, Param, Query } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { RecapsService } from './recaps.service';
import { CreateRecapDto, UpdateRecapDto, ReviewRecapDto } from './dto/create-recap.dto';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { Role } from '@prisma/client';

@ApiTags('Recaps')
@ApiBearerAuth()
@Controller('recaps')
export class RecapsController {
  constructor(private readonly recapsService: RecapsService) {}

  @Post()
  @Roles(Role.CLIENT)
  @ApiOperation({ summary: 'Create a new weekly recap (DRAFT)' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateRecapDto,
  ) {
    return this.recapsService.create(user.id, dto);
  }

  @Get('my')
  @Roles(Role.CLIENT)
  @ApiOperation({ summary: "Get client's own recap history" })
  findMyRecaps(
    @CurrentUser() user: AuthenticatedUser,
    @Query() pagination: PaginationDto,
  ) {
    return this.recapsService.findMyRecaps(user.id, pagination);
  }

  @Get()
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({ summary: "Get submitted/reviewed recaps for admin's clients" })
  findForAdmin(
    @CurrentUser() user: AuthenticatedUser,
    @Query() pagination: PaginationDto,
  ) {
    return this.recapsService.findForAdmin(user.id, pagination);
  }

  @Put(':id')
  @Roles(Role.CLIENT)
  @ApiOperation({ summary: 'Update a recap (only if owner and not REVIEWED)' })
  update(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateRecapDto,
  ) {
    return this.recapsService.update(user.id, id, dto);
  }

  @Post(':id/submit')
  @Roles(Role.CLIENT)
  @ApiOperation({ summary: 'Submit a recap' })
  submit(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.recapsService.submit(user.id, id);
  }

  @Put(':id/review')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Mark a recap as reviewed' })
  review(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ReviewRecapDto,
  ) {
    return this.recapsService.review(user.id, id, dto);
  }
}
