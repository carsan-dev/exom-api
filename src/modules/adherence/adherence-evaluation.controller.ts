import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AdherenceEvaluationService } from './adherence-evaluation.service';
import { AdherencePeriodQueryDto } from './dto/adherence-period-query.dto';

@ApiTags('Admin - Adherence')
@ApiBearerAuth()
@Controller('admin/clients/:clientId/adherence')
@Roles(Role.ADMIN, Role.SUPER_ADMIN)
export class AdherenceEvaluationController {
  constructor(private readonly evaluation: AdherenceEvaluationService) {}
  @Get()
  get(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('clientId') client: string,
    @Query() query: AdherencePeriodQueryDto,
  ) {
    return this.evaluation.get(actor.id, actor.role, client, query);
  }
}

@ApiTags('Adherence')
@ApiBearerAuth()
@Controller('adherence')
@Roles(Role.CLIENT)
export class ClientAdherenceEvaluationController {
  constructor(private readonly evaluation: AdherenceEvaluationService) {}
  @Get()
  get(
    @CurrentUser() actor: AuthenticatedUser,
    @Query() query: AdherencePeriodQueryDto,
  ) {
    return this.evaluation.get(actor.id, actor.role, actor.id, query);
  }
}
