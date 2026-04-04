import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { DashboardService } from './dashboard.service';
import { AdminDashboardResponseDto } from './dto/admin-dashboard-response.dto';

@ApiTags('Dashboard')
@ApiBearerAuth()
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get()
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Obtener resumen ejecutivo del dashboard admin' })
  @ApiOkResponse({ type: AdminDashboardResponseDto })
  getAdminDashboard(@CurrentUser() user: AuthenticatedUser) {
    return this.dashboardService.getAdminDashboard(user.id);
  }
}
