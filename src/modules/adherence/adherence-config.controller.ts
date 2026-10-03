import { Body, Controller, Get, Param, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AdherenceConfigService } from './adherence-config.service';
import {
  AdherenceConfigDateQueryDto,
  UpdateAdherenceConfigDto,
} from './dto/adherence-config.dto';

@ApiTags('Admin - Adherence')
@ApiBearerAuth()
@Controller('admin/clients/:clientId/adherence/config')
@Roles(Role.ADMIN, Role.SUPER_ADMIN)
export class AdherenceConfigController {
  constructor(private readonly config: AdherenceConfigService) {}

  @Get()
  @ApiOperation({
    summary:
      'Read client adherence policy as of a UTC date; uncaptured history is unknown',
  })
  get(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('clientId') clientId: string,
    @Query() query: AdherenceConfigDateQueryDto,
  ) {
    return this.config.get(actor.id, actor.role, clientId, query.date);
  }

  @Put()
  @ApiOperation({
    summary:
      'Append a future effective-dated client adherence policy with optimistic version',
  })
  update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('clientId') clientId: string,
    @Body() dto: UpdateAdherenceConfigDto,
  ) {
    return this.config.update(actor.id, actor.role, clientId, dto);
  }
}
