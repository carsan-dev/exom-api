import {
  Controller,
  Delete,
  Get,
  Post,
  Put,
  Body,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { ProfileService } from './profile.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { MarkOnboardingDto } from './dto/mark-onboarding.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '@prisma/client';

@ApiTags('Profile')
@ApiBearerAuth()
@Controller('profile')
export class ProfileController {
  constructor(private readonly profileService: ProfileService) {}

  @Get('me')
  @ApiOperation({ summary: 'Get my profile' })
  getMyProfile(@CurrentUser() user: AuthenticatedUser) {
    return this.profileService.getMyProfile(user.id);
  }

  @Put('me')
  @ApiOperation({ summary: 'Update my profile' })
  updateMyProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateProfileDto,
  ) {
    return this.profileService.updateMyProfile(user.id, dto);
  }

  @Post('me/onboarding')
  @Roles(Role.CLIENT)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Mark my onboarding as finished (idempotent, first write wins); returns the stored mark',
  })
  @ApiResponse({ status: 403, description: 'Only clients have onboarding' })
  @ApiResponse({ status: 404, description: 'Perfil no encontrado' })
  markOnboarding(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: MarkOnboardingDto,
  ) {
    return this.profileService.markOnboarding(user.id, dto);
  }

  @Put('me/avatar')
  @ApiOperation({ summary: 'Get presigned URL for avatar upload' })
  @HttpCode(HttpStatus.OK)
  getAvatarUploadUrl(@CurrentUser() user: AuthenticatedUser) {
    return this.profileService.getAvatarUploadUrl(user.id, user.role);
  }

  @Delete('me')
  @ApiOperation({ summary: 'Eliminar mi cuenta y todos los datos asociados' })
  @ApiResponse({ status: 200, description: 'Cuenta eliminada correctamente' })
  @ApiResponse({ status: 404, description: 'Usuario no encontrado' })
  @HttpCode(HttpStatus.OK)
  deleteMyAccount(@CurrentUser() user: AuthenticatedUser) {
    return this.profileService.deleteMyAccount(user.id);
  }
}
