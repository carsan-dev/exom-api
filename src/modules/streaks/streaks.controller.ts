import { Controller, Get, Post, Param, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { StreaksService } from './streaks.service';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { Role } from '@prisma/client';

@ApiTags('Streaks')
@ApiBearerAuth()
@Controller('streaks')
export class StreaksController {
  constructor(private readonly streaksService: StreaksService) {}

  @Get('me')
  @Roles(Role.CLIENT)
  @ApiOperation({ summary: 'Get current client streak' })
  getStreak(@CurrentUser() user: AuthenticatedUser) {
    return this.streaksService.getStreak(user.id);
  }

  @Post(':clientId/reset')
  @Roles(Role.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reset streak of a client (ADMIN only)' })
  resetStreak(@Param('clientId') clientId: string) {
    return this.streaksService.resetStreak(clientId);
  }
}
